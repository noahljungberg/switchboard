// Slack: the port the rest of the code talks to, the Bolt (Socket Mode) adapter behind it, and the
// bridge that mirrors threads into Slack and routes Slack messages and button presses into the core.
// Contract: docs/design/slack.md.

import bolt from '@slack/bolt';
import { type Core, type CoreEvent, MAX_BODY, type Principal, type Thread, SwitchboardError, outsideCode, principalActor, principalOf, privateTo, tagPattern } from './core.ts';
import { type StandingDecision, type Windows, fmt, titleFrom } from './windows.ts';

// ---- the port (tests use test/fakes.ts) ----

export type Block = Record<string, unknown>;
export interface SlackPost { channel: string; threadTs?: string; text: string; blocks?: Block[] }
export interface SlackPort {
  post(msg: SlackPost): Promise<{ channel: string; ts: string }>;
  update(msg: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<void>;
  ephemeral(msg: { channel: string; user: string; text: string; threadTs?: string }): Promise<void>;
  openDm(slackUserId: string): Promise<string>;
}

export interface InboundMessage { channel: string; channelType: string; user: string; text: string; ts: string; threadTs?: string }
export interface InboundAction { actionId: string; value: string; user: string; channel: string; messageTs: string; threadTs?: string }

// ---- text helpers ----

/** Escapes Slack control characters so agent text can't ping @channel or forge mentions. */
export const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/**
 * Clips text that is already escaped (escaping can grow it 5x) to `n` UTF-16 units, Slack's own count, whole code points
 * at a time, so it never cuts an emoji, an entity like &amp; or a <@U…> mention in half.
 */
const fit = (s: string, n: number): string => {
  if (s.length <= n) return s;
  let cut = '';
  for (const ch of s) {
    if (cut.length + ch.length > n - 1) break;
    cut += ch;
  }
  return `${cut.replace(/&[a-z]*$|<[^>]*$/, '')}…`;
};
const quote = (s: string, n = 2500): string => fit(escapeSlack(s).split('\n').map((l) => `> ${l}`).join('\n'), n);
/**
 * An agent's words inside a system card (a window's title, P2): inline code, its own backticks turned into quotes and its
 * emoji taken out, so no emoji, emoji shortcode or mrkdwn in it renders beside the core's words, and it reads as the
 * agent's. Slack applies no formatting inside a code span. Empty when nothing is left.
 */
const agentWords = (s: string, n: number): string => {
  const plain = s.replace(/`/g, "'").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  return plain ? `\`${fit(escapeSlack(plain), n)}\`` : '';
};
const SECTION_MAX = 3000; // Slack refuses a section block with longer text (invalid_blocks)
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text: fit(text, SECTION_MAX) } });
// The ops agent posts from the same bot as the system cards, and an LLM can print "Approved by …". Its words go
// out as plain text only, so this footer, which every system card carries, tells the core's facts from its
// text (P6, P1, P3).
const FOOTER: Block = { type: 'context', elements: [{ type: 'mrkdwn', text: 'switchboard' }] };
// P2: every system card, summary and notice is one short line for a human. The renderers aim well under this; the cap
// holds whatever an agent or the config wrote. (Ops text keeps its own 500-character cap (P2), enforced in ops-mcp.ts.)
export const CARD_MAX = 300;
const card = (text: string, ...more: Block[]): { text: string; blocks: Block[] } => {
  const line = fit(text, CARD_MAX);
  return { text: line, blocks: [section(line), ...more, FOOTER] };
};

// Errors no retry fixes: the message itself is wrong. Anything else (rate limit, Slack down, a channel the bot
// isn't in yet) stays for the sweep, so the mirror catches up once it's fixed.
const PERMANENT = /\b(invalid_blocks|invalid_blocks_format|msg_too_long|msg_blocks_too_long|no_text|invalid_attachments|too_many_attachments)\b/;
const slackError = (err: unknown): string => String((err as { data?: { error?: unknown } })?.data?.error ?? (err as Error)?.message ?? '');
const permanent = (err: unknown): string | null => PERMANENT.exec(slackError(err))?.[1] ?? null;
// A reply whose parent is gone (deleted in Slack). Slack documents no error for that; these are the ones it may give.
const PARENT_GONE = /\b(thread_not_found|message_not_found|cannot_reply_to_message)\b/;
const GONE = 'root_gone' as const;
// chat.update errors no retry fixes: the card is gone or can't be edited any more.
const CANT_EDIT = /\b(message_not_found|cant_update_message|edit_window_closed)\b/;
// An urgent window's report on its card: the outcome in a word (P2).
const REPORTED: Record<string, [string, string]> = {
  done: [':white_check_mark:', 'Done'], rolled_back: [':leftwards_arrow_with_hook:', 'Rolled back'], failed: [':x:', 'Failed'], partial: [':warning:', 'Partial'],
};
/** "A, B and C", or "A, B and 3 more" past `max` characters: a supplementary standing card names its resources inline (P2). */
function inline(names: string[], max = 120): string {
  const all = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
  if (all.length <= max) return all;
  if (names.length === 1) return fit(all, max);
  let k = names.length - 1;
  while (k > 1 && `${names.slice(0, k).join(', ')} and ${names.length - k} more`.length > max) k--;
  return `${fit(names.slice(0, k).join(', '), max)} and ${names.length - k} more`;
}

export interface BridgeOptions { core: Core; port: SlackPort; opsChannel: string; botUserId: string; windows?: Windows }

export class SlackBridge {
  readonly core: Core;
  readonly port: SlackPort;
  readonly opsChannel: string;
  readonly botUserId: string;
  readonly windows: Windows | undefined;
  private chains = new Map<string, Promise<void>>();
  private dmChannels = new Map<string, string>();

  constructor(options: BridgeOptions) {
    this.core = options.core;
    this.port = options.port;
    this.opsChannel = options.opsChannel;
    this.botUserId = options.botUserId;
    this.windows = options.windows;
  }

  /** Mirrors every new event; sweep() retries threads whose mirror fell behind (Slack down, rate limit). */
  start(): void {
    this.core.onEvent((event) => { void this.sync(event.thread_id); });
  }

  sync(threadId: string): Promise<void> {
    const next = (this.chains.get(threadId) ?? Promise.resolve())
      .then(() => this.syncNow(threadId))
      .catch((err) => console.error(`slack mirror for ${threadId} failed; sweep will retry`, err));
    this.chains.set(threadId, next);
    return next;
  }

  async sweep(): Promise<void> {
    const behind = this.core.db.prepare(
      'SELECT t.id FROM threads t WHERE t.slack_synced_seq < (SELECT MAX(seq) FROM events e WHERE e.thread_id = t.id)').all() as Array<{ id: string }>;
    await Promise.all(behind.map((t) => this.sync(t.id)));
  }

  private async syncNow(threadId: string): Promise<void> {
    let thread = this.core.requireThread(threadId);
    const events = this.core.events(threadId, thread.slack_synced_seq);
    if (events.length === 0) return;
    // Resolved only when an event renders: a DM thread full of agent items opens no DM, so a failing openDm isn't
    // retried on every sync of something that would post nothing anyway.
    let target: { channel: string; threaded: boolean } | null | undefined;
    for (const event of events) {
      const rendered = this.render(thread, event);
      if (rendered && target === undefined) target = await this.target(thread);
      if (rendered && target) {
        const { replaceRoot, rewriteOnly, also, ...msg } = rendered;
        const rewritten = replaceRoot && thread.slack_ts ? await this.replaced(thread.slack_channel ?? target.channel, thread.slack_ts, msg, thread.id) : false;
        // A re-render (admin rerender-cards) only edits: a card Slack can no longer edit stays as it was.
        if (!rewritten && !rewriteOnly) thread = await this.postIn(thread, target, msg);
        // A reply that must notify (a failed report): Slack doesn't notify a mention in an edited message.
        if (also) await this.postIn(thread, target, also);
      }
      this.core.setSlackSynced(thread.id, event.seq);
    }
  }

  /** Posts one message in a thread's Slack thread (or as its root), and returns the thread with its root saved. */
  private async postIn(thread: Thread, target: { channel: string; threaded: boolean }, msg: { text: string; blocks?: Block[] }): Promise<Thread> {
    let root = target.threaded ? thread.slack_ts : null;
    let posted = await this.deliver({ channel: target.channel, ...(root ? { threadTs: root } : {}), ...msg }, thread.id);
    if (posted === GONE) {
      // Its Slack root was deleted: the thread starts again, with this message as a new top-level post.
      console.error(`slack root of ${thread.id} is gone; posting a new root`);
      root = null;
      posted = await this.deliver({ channel: target.channel, ...msg }, thread.id);
    }
    // No header post: the first message a thread shows in Slack is its root, and replies to it route back here (P3).
    if (target.threaded && !root && posted && posted !== GONE) {
      this.core.setSlackAnchor(thread.id, posted.channel, posted.ts);
      return this.core.requireThread(thread.id);
    }
    return thread;
  }

  /**
   * Rewrites a thread's root card (P5: an urgent window's decision and clock change its card, never post).
   * False when Slack can't edit that message for good, so the caller posts the card under it instead (unless it is
   * only a re-render); a transient failure throws, and the sweep retries.
   */
  private async replaced(channel: string, ts: string, msg: { text: string; blocks?: Block[] }, threadId: string): Promise<boolean> {
    try {
      await this.port.update({ channel, ts, ...msg });
      return true;
    } catch (err) {
      const why = CANT_EDIT.exec(slackError(err))?.[1] ?? permanent(err);
      if (!why) throw err;
      console.error(`slack can't rewrite the card of ${threadId} (${why})`);
      return false;
    }
  }

  /**
   * Posts one event. If Slack refuses the message itself, posts it once as plain text instead of retrying forever;
   * if the reply's parent is gone, says so (GONE) for syncNow to start a new root.
   */
  private async deliver(msg: SlackPost, threadId: string): Promise<{ channel: string; ts: string } | null | typeof GONE> {
    try {
      return await this.port.post(msg);
    } catch (err) {
      if (msg.threadTs && PARENT_GONE.test(slackError(err))) return GONE;
      const why = permanent(err);
      if (!why) throw err;
      console.error(`slack refused an event in ${threadId} (${why}); posting it as plain text`);
      try {
        return await this.port.post({ channel: msg.channel, ...(msg.threadTs ? { threadTs: msg.threadTs } : {}),
          text: `${fit(msg.text, SECTION_MAX)}\n_(Slack refused this message as sent (${why}), so here it is as plain text, without buttons. The whole thread: \`switchboard admin export-thread ${threadId}\`.)_` });
      } catch (again) {
        if (!permanent(again)) throw again;
        console.error(`slack refused the plain text for ${threadId} too; skipping that event`);
        return null;
      }
    }
  }

  /** Where a thread shows up in Slack. Private threads only reach their own principal's DMs (plan §9). */
  private async target(thread: Thread): Promise<{ channel: string; threaded: boolean } | null> {
    if (thread.kind === 'dm') {
      if (thread.slack_channel) return { channel: thread.slack_channel, threaded: false };
      // A DM the core opened (P3: the ops agent tells a human what their agents wrote) before the human ever wrote in it.
      const slackUser = this.core.principal(thread.visibility.slice('private:'.length))?.slack_user_id;
      if (!slackUser) return null;
      const channel = await this.dmChannel(slackUser);
      this.core.setSlackAnchor(thread.id, channel, null);
      return { channel, threaded: false };
    }
    if (thread.visibility === 'shared') return { channel: this.opsChannel, threaded: true };
    const owner = thread.visibility.slice('private:'.length);
    if (!this.core.isParticipant(thread.id, principalActor(owner))) return null; // agent-to-agent inside one principal: never mirrored
    const slackUser = this.core.principal(owner)?.slack_user_id;
    return slackUser ? { channel: await this.dmChannel(slackUser), threaded: true } : null;
  }

  private async dmChannel(slackUserId: string): Promise<string> {
    let channel = this.dmChannels.get(slackUserId);
    if (!channel) this.dmChannels.set(slackUserId, (channel = await this.port.openDm(slackUserId)));
    return channel;
  }

  mention(principalId: string): string {
    const p = this.core.principal(principalId);
    return p?.slack_user_id ? `<@${p.slack_user_id}>` : `*${escapeSlack(p?.name ?? principalId)}*`;
  }

  who(actor: string): string {
    if (actor === 'ops') return 'ops agent';
    if (actor === 'system') return 'switchboard';
    if (actor.startsWith('principal:')) return this.core.principal(principalOf(actor)!)?.name ?? actor;
    const id = actor.slice('agent:'.length);
    const p = this.core.principal(principalOf(actor)!);
    return `*${escapeSlack(id.split('/')[1] ?? id)}* (${escapeSlack(p?.name ?? '?')}'s agent)`;
  }

  /** Ops text may tag principals as @id (outside code); everything else is escaped. */
  opsText(text: string): string {
    return outsideCode(escapeSlack(text), (part) => {
      for (const p of this.core.principals()) part = part.replace(tagPattern(p.id), this.mention(p.id));
      return part;
    });
  }

  /**
   * `replaceRoot`: rewrite the thread's root card with this instead of posting it (P5); `rewriteOnly`: and never post
   * it. `also`: a reply to post under the card as well, for what must notify.
   */
  render(thread: Thread, e: CoreEvent): { text: string; blocks?: Block[]; replaceRoot?: boolean; rewriteOnly?: boolean; also?: { text: string; blocks: Block[] } } | null {
    const b = e.body;
    const text = typeof b['text'] === 'string' ? b['text'] : '';
    // An agents-only thread shows up in Slack only when the ops agent tags a human there: a page, whose first
    // post becomes the thread's root (P3). Everything else in it reaches the agents' inboxes only.
    if (this.core.agentsOnly(thread, e.seq)) {
      const page = e.actor === 'ops' && e.type === 'message' && this.core.tagged(text).length > 0;
      return page ? { text: this.opsText(text) } : null;
    }
    // A window's or a standing card's new state rewrites its root message in place (P5).
    const rewrite = () => { const root = this.rootCard(thread, e); return root && { ...root, replaceRoot: true }; };
    switch (e.type) {
      case 'message': {
        if (b['via'] === 'slack') return null; // already in Slack
        // Plain text, never blocks: only system cards carry the footer (FOOTER). Slack already names the bot.
        if (e.actor === 'ops') return { text: this.opsText(text) };
        // P3: agents never post to Slack, not even to a human or in a thread a human is part of: the ops agent reads
        // their words and tells the human what they need (tell_human, respond).
        return null;
      }
      // P3: an agent's question posts nothing; it waits for the ops agent, whose card (ask_presented) is the one humans see.
      case 'ask_presented': {
        const options = Array.isArray(b['options']) ? (b['options'] as string[]) : [];
        // Without buttons the card says where to answer; the line is cut to leave room for that, under the cap (P2).
        const hint = options.length ? '' : `\n_Reply ${thread.kind === 'dm' ? 'here' : 'in this thread'}._`;
        const line = this.askLine(thread, String(b['who']), text, CARD_MAX - hint.length);
        if (options.length === 0) return { text: `${line}${hint}` };
        return {
          text: line,
          blocks: [
            section(line),
            // The asking agent's own options; the button answers its ask_human event (Core.answerAsk).
            { type: 'actions', elements: options.map((o, i) => ({
              type: 'button', action_id: `sb_ask_${i}`, text: { type: 'plain_text', text: o },
              value: JSON.stringify({ t: b['ask_thread'], s: b['ask_seq'], i }),
            })) },
          ],
        };
      }
      // human_answer isn't posted: the button press already rewrote the question card with the answer (P3).
      // relay_request isn't either: it is agent-to-ops traffic.
      case 'notice': {
        // A notice's `reason` (a memory edit's, the ops agent's words) and `detail` (an engine's own error text) sit
        // inside a system card: each is one quoted, capped line, so it can't add a line that passes for the core's.
        const quoted = ['reason', 'detail'].map((k) => b[k]).filter((v): v is string => typeof v === 'string')
          .map((v) => `\n${quote(v.replace(/\s+/g, ' ').trim(), 300)}`).join('');
        return card(`${this.opsText(text)}${quoted}`);
      }
      case 'window_requested':
      case 'standing_requested':
        return this.rootCard(thread, e); // a new post, the thread's root
      case 'approval_request': // the ops agent's re-post (request_approval), under the card
        return card(this.windowAsk(b, String(b['requested_by']), this.requestedAt(thread, e), 'Still needs a decision.'), this.windowButtons(b['window']));
      // An urgent window is one card (P5): its decision, start, end, expiry and report rewrite it in place, one line
      // each (P2). Only what must notify is a reply that tags the requester's human: the overdue page, a failed report.
      case 'window_reminder':
        if (b['kind'] === 'overdue') {
          return card(`${this.mention(principalOf(`agent:${String(b['requested_by'])}`)!)}: ${this.who(`agent:${String(b['requested_by'])}`)} hasn't reported its window on *${escapeSlack(String(b['resource_name']))}* (ended ${fmt(String(b['end']), true)}). Is prod in a known state?`);
        }
        return rewrite();
      case 'window_decision':
      case 'window_state':
      case 'standing_decision':
      case 'standing_void':
        return rewrite();
      case 'window_report': {
        const root = rewrite();
        if (!root || b['outcome'] !== 'failed') return root;
        const requester = this.core.events(thread.id, 0, 1)[0]?.actor ?? e.actor;
        return { ...root, also: card(`${this.mention(principalOf(requester) ?? '')}: ${this.who(e.actor)} reported a failed change on *${escapeSlack(String(b['resource_name']))}*. Is prod in a known state?`) };
      }
      case 'card_rerender': {
        // switchboard admin rerender-cards (P2): the card as it stands now, in the current format, on its own message.
        for (const x of this.core.events(thread.id, 0, e.seq - 1).reverse()) {
          const root = this.rootCard(thread, x);
          if (root) return { ...root, replaceRoot: true, rewriteOnly: true };
        }
        return null;
      }
      default:
        return null;
    }
  }

  /** A presented question's one line (P3): the ops agent's words, tagging the human unless it is in their own DM. */
  private askLine(thread: Thread, who: string, text: string, max = CARD_MAX): string {
    return fit(thread.kind === 'dm' ? this.opsText(text) : `${this.mention(who)} ${this.opsText(text)}`, max);
  }

  /** A window's or a standing card's root message as of event `x`, or null when `x` doesn't change it. */
  private rootCard(thread: Thread, x: CoreEvent): { text: string; blocks: Block[] } | null {
    switch (x.type) {
      case 'window_requested':
        return card(this.windowAsk(x.body, x.actor.slice('agent:'.length), x.created_at), this.windowButtons(x.body['window']));
      case 'window_decision':
      case 'window_state':
      case 'window_reminder': // only `ended` changes it; the overdue page is a reply, a T-10 reminder from an older version nothing
      case 'window_report':
        return this.windowUpdate(thread, x);
      case 'standing_requested':
      case 'standing_decision':
      case 'standing_void':
        return this.standingCard(thread, x);
      default:
        return null;
    }
  }

  /**
   * "Core API and DB, 13:23–14:08 UTC: raise API rate limits": the resource, the time (with the date when it
   * isn't the day it was requested) and the title. Never the plan, rollback, verify or a report's evidence: they stay in
   * switchboard, for the agents and the ops agent (P2).
   */
  private windowHead(r: Record<string, unknown>, requestedAt: string): string {
    const start = String(r['start']);
    const hm = (iso: string) => fmt(iso, true).slice(0, 5);
    const day = start.slice(0, 10) === requestedAt.slice(0, 10) ? '' : `${fmt(start).slice(0, -' 00:00 UTC'.length)} `;
    const title = agentWords(typeof r['title'] === 'string' ? r['title']
      : this.windows?.window(String(r['window']))?.title ?? (typeof r['plan'] === 'string' ? titleFrom(r['plan']) : ''), 100);
    return `${fit(escapeSlack(String(r['resource_name'] ?? r['resource'])), 60)}, ${day}${hm(start)}–${hm(String(r['end']))} UTC${title ? `: ${title}` : ''}`;
  }

  /** "scout, Alice's agent" */
  private agentLabel(agentId: string): string {
    return `${escapeSlack(agentId.split('/')[1] ?? agentId)}, ${escapeSlack(this.core.principal(principalOf(`agent:${agentId}`) ?? '')?.name ?? '?')}'s agent`;
  }

  /** When the window's thread got its request, which decides whether its line names the date. */
  private requestedAt(thread: Thread, e: CoreEvent): string {
    const first = this.core.events(thread.id, 0, 1)[0];
    return first?.type === 'window_requested' ? first.created_at : e.created_at;
  }

  /** The card that asks: who must approve, the window's one line and who asked, then the standing rule as one clause. */
  private windowAsk(r: Record<string, unknown>, requestedBy: string, requestedAt: string, status = ''): string {
    const approvers = (Array.isArray(r['approvers']) ? r['approvers'] as string[] : []).map((p) => this.mention(p)).join(r['require'] === 'all' ? ' and ' : ' or ');
    const rule = typeof r['note'] === 'string' && r['note'].trim() ? fit(escapeSlack(r['note'].replace(/\s+/g, ' ').trim()), 100) : '';
    const tail = [status, rule].filter(Boolean).join(' ');
    return `:wrench: ${approvers} ${this.windowHead(r, requestedAt)} (${this.agentLabel(requestedBy)})${tail ? `. ${tail}` : ''}`;
  }

  // No "Suggest another time" (P2): it tagged the requester's human in a card rewrite, which Slack doesn't notify, and
  // a declined agent re-requests anyway. An old card's button still works (decideFromSlackButton keeps 'suggest').
  private windowButtons(windowId: unknown, which: Array<'approve' | 'decline'> = ['approve', 'decline']): Block {
    const button = (action: string, label: string, style: string) => ({
      type: 'button', action_id: `sb_win_${action}`, text: { type: 'plain_text', text: label }, value: JSON.stringify({ w: windowId }), style,
    });
    const all = { approve: button('approve', 'Approve', 'primary'), decline: button('decline', 'Decline', 'danger') };
    return { type: 'actions', elements: which.map((k) => all[k]) };
  }

  private names(ids: string[]): string {
    return ids.map((p) => escapeSlack(this.core.principal(p)?.name ?? p)).join(' and ');
  }

  /**
   * The window's card as of event `e`, one line (P2): where it stands, with the buttons only while a decision is still
   * open. It replaces the card in place (P5). A report shows its outcome in a word, never its evidence.
   */
  private windowUpdate(thread: Thread, e: CoreEvent): { text: string; blocks: Block[] } | null {
    const b = e.body;
    // The card's line comes from the request it was posted with; a thread without one (a test) uses the event's fields.
    const first = this.core.events(thread.id, 0, 1)[0];
    const request = first?.type === 'window_requested' ? first : null;
    const r = request?.body ?? b;
    const head = this.windowHead(r, request?.created_at ?? e.created_at);
    const done = (text: string) => card(text);
    const open = (status: string) =>
      card(`:wrench: ${head} (${this.agentLabel(request ? request.actor.slice('agent:'.length) : String(b['requested_by']))}). ${status}`, this.windowButtons(r['window'] ?? b['window']));
    if (e.type === 'window_decision') {
      const by = this.names([String(b['by'])]);
      // An old card's button (windowButtons). One recorded for an approved window, before that was refused, changes nothing.
      if (b['decision'] === 'suggest') return b['state'] === 'proposed' ? open(`${by} asked for another time.`) : null;
      // Require any: until the window starts either owner can overrule the other, so the card keeps the opposite button.
      const keep = (text: string, button: 'approve' | 'decline') => (r['require'] === 'all' ? done(text) : card(text, this.windowButtons(r['window'] ?? b['window'], [button])));
      if (b['decision'] === 'decline') return keep(`:no_entry: ${head}. Declined by ${by}.`, 'approve');
      const approved = Array.isArray(b['approved']) ? b['approved'] as string[] : [String(b['by'])];
      if (b['state'] === 'approved') return keep(`:white_check_mark: ${head}. Approved by ${this.names(approved)}.`, 'decline');
      const waiting = (Array.isArray(r['approvers']) ? r['approvers'] as string[] : []).filter((p) => !approved.includes(p));
      return open(`Approved by ${this.names(approved)}; waiting for ${waiting.length ? this.names(waiting) : 'the other approver'}.`);
    }
    if (e.type === 'window_state') {
      if (b['state'] === 'active') return done(`:construction: ${head}. In progress until ${fmt(String(b['end'] ?? r['end']), true).slice(0, 5)}.`);
      return b['state'] === 'expired' ? done(`:heavy_minus_sign: ${head}. Expired, not approved.`) : null;
    }
    if (e.type === 'window_reminder') return b['kind'] === 'ended' ? done(`:hourglass_flowing_sand: ${head}. Ended, waiting for the report.`) : null;
    const [emoji, word] = REPORTED[String(b['outcome'])] ?? [':grey_question:', escapeSlack(String(b['outcome']))];
    return done(`${emoji} ${head}. ${word}.`);
  }

  /**
   * A standing-approval card (P5), one line (P2): the slot, how many resources and whose agents, and the approver's
   * buttons. It is posted when a change needs something none of their cards for this version lists (the first card, or a
   * supplementary one for what a wider config adds, which names its resources inline); each decision, and a new
   * schedule, rewrites it in place. What it approves is its stored pairs (`standing_cards.covers`), which
   * list_maintenance shows in full.
   */
  private standingCard(thread: Thread, e: CoreEvent): { text: string; blocks: Block[] } {
    const request = this.core.events(thread.id, 0, 1)[0];
    const r = request?.type === 'standing_requested' ? request.body : e.body;
    const approver = String(r['approver']);
    const covers = Array.isArray(r['covers']) ? r['covers'] as Array<{ name: string; principals: string[] }> : [];
    const whose = `${[...new Set(covers.flatMap((c) => c.principals))].map((p) => `${this.names([p])}'s`).join(' and ')} agents`;
    const names = inline(covers.map((c) => escapeSlack(c.name)));
    const slot = `Nightly maintenance ${String(r['start'])}–${String(r['end'])} UTC${r['extra'] === true ? `, also for ${names}` : ''}`;
    const who = this.names([approver]);
    const button = (action: StandingDecision, label: string, style: string) => ({
      type: 'button', action_id: `sb_std_${action}`, text: { type: 'plain_text', text: label }, value: JSON.stringify({ k: r['card'] }), style,
    });
    let text: string;
    let buttons: Block[] = [];
    if (e.type === 'standing_requested' && r['already'] === true) {
      // Pairs the other owner already approved (require any): an offer to overrule, not a request (P2).
      text = `:calendar: ${this.mention(approver)} You can now also approve or revoke nightly maintenance for ${names} (${whose}). It's approved already: nothing is needed.`;
      buttons = [button('approve', 'Approve', 'primary'), button('revoke', 'Revoke', 'danger')];
    } else if (e.type === 'standing_requested') {
      const n = covers.length;
      text = r['extra'] === true
        ? `:calendar: ${this.mention(approver)} Nightly maintenance also needs your OK for ${names} (${whose}).`
        : `:calendar: ${this.mention(approver)} Nightly maintenance ${String(r['start'])}–${String(r['end'])} UTC for ${n} shared resource${n === 1 ? '' : 's'} (${whose}). Approve once?`;
      buttons = [button('approve', 'Approve', 'primary'), button('decline', 'Decline', 'danger')];
    } else if (e.type === 'standing_void') {
      text = `:calendar: ${slot}. Void: the slot moved to ${String(e.body['start'])}–${String(e.body['end'])} UTC.`;
    } else {
      // Either owner's latest decision wins (Windows.coverage), so a decided card keeps both: Approve overrules a later
      // revoke by the other owner, Revoke their later approval. A press that changes nothing is refused.
      text = `:calendar: ${slot}. ${e.body['decision'] === 'approve' ? 'Approved' : e.body['decision'] === 'decline' ? 'Declined' : 'Revoked'} by ${who}.`;
      buttons = [button('approve', 'Approve', 'primary'), button('revoke', 'Revoke', 'danger')];
    }
    return card(text, ...(buttons.length ? [{ type: 'actions', elements: buttons }] : []));
  }

  // ---- inbound ----

  async onMessage(m: InboundMessage): Promise<void> {
    if (m.user === this.botUserId) return;
    const principal = this.core.principalBySlack(m.user);
    if (!principal) return; // only principals talk to switchboard
    const mentioned = [...m.text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((x) => x[1]!);
    const body = {
      text: m.text, via: 'slack', slack_ts: m.ts,
      mentions_bot: mentioned.includes(this.botUserId),
      mentions: mentioned.filter((id) => id !== this.botUserId).map((id) => this.core.principalBySlack(id)?.id ?? `slack:${id}`),
    };
    if (m.channelType === 'im') {
      let thread = m.threadTs ? this.core.threadBySlack(m.channel, m.threadTs) : undefined;
      if (thread && thread.visibility !== privateTo(principal.id)) thread = undefined;
      thread ??= this.core.dmThread(principal.id, m.channel);
      if (this.logged(thread, m.ts)) return;
      this.core.postMessage(thread, principalActor(principal.id), { ...body, dm: true });
      // A question with no options presented in their DM has no buttons: their next reply there is its answer. Not a
      // message to the ops agent (it mentions the bot), and not an empty (a file with no caption) or oversized one.
      const open = thread.kind === 'dm' && !body.mentions_bot && m.text.trim() && m.text.length <= MAX_BODY ? this.core.openOptionlessAsk(thread.id) : undefined;
      if (open) {
        try { this.core.answerAsk(open.thread_id, open.event_seq, principal.id, m.text); } catch (err) {
          if (!(err instanceof SwitchboardError)) throw err;
          console.error(`a DM reply couldn't answer ask ${open.id} (${err.code})`);
        }
      }
      return;
    }
    if (m.channel !== this.opsChannel) return;
    const anchor = m.threadTs ?? m.ts;
    let thread = this.core.threadBySlack(m.channel, anchor);
    if (!thread) {
      if (!body.mentions_bot) return; // channel chatter that isn't for the bot stays out of the log
      thread = this.core.createThread({
        kind: 'chat', visibility: 'shared', title: clip(m.text.replace(/<@[A-Z0-9]+>/g, '').trim() || 'Slack thread', 80),
        participants: [principalActor(principal.id), 'ops'], slack: { channel: m.channel, ts: anchor },
      });
    }
    if (this.logged(thread, m.ts)) return;
    // Replying to a page makes the human part of that thread: from then on it is theirs too, in Slack (P3).
    this.core.join(thread.id, principalActor(principal.id));
    this.core.postMessage(thread, principalActor(principal.id), body);
  }

  /** Socket Mode redelivers events it thinks weren't acked. A thread is one Slack channel, so (thread, ts) is one message. */
  private logged(thread: Thread, ts: string): boolean {
    return !!this.core.db.prepare("SELECT 1 FROM events WHERE thread_id = ? AND json_extract(body, '$.slack_ts') = ?").get(thread.id, ts);
  }

  async onAction(a: InboundAction): Promise<void> {
    const principal = this.core.principalBySlack(a.user);
    const tell = (text: string) => this.port.ephemeral({ channel: a.channel, user: a.user, text, ...(a.threadTs ? { threadTs: a.threadTs } : {}) });
    if (!principal) return tell('Only switchboard\'s principals can answer its buttons.');
    let value: Record<string, unknown>;
    try { value = JSON.parse(a.value) as Record<string, unknown>; } catch { return tell('That button is malformed.'); }
    try {
      if (a.actionId.startsWith('sb_ask_')) {
        const ask = this.core.event(String(value['t']), Number(value['s']));
        const option = Array.isArray(ask?.body['options']) ? (ask.body['options'] as string[])[Number(value['i'])] : undefined;
        if (!ask || option === undefined) return tell('That question no longer exists.');
        this.core.answerAsk(ask.thread_id, ask.seq, principal.id, option);
        const answered = `*${escapeSlack(principal.name)} answered: ${escapeSlack(option)}*`;
        // P3: the card shows the ops agent's words; a card from before migration 14 showed the agent's question, quoted.
        const shown = this.core.askByEvent(ask.thread_id, ask.seq);
        const head = shown?.text && shown.card_thread ? this.askLine(this.core.requireThread(shown.card_thread), shown.principal, shown.text) : quote(String(ask.body['question']));
        try {
          await this.port.update({ channel: a.channel, ts: a.messageTs, text: `${head}\n${answered}` });
        } catch (err) {
          // The answer is recorded; without the update the card shows none and keeps its buttons, so say it under it.
          console.error(`slack update of the answered card in ${ask.thread_id} failed; posting the answer under it`, err);
          await this.port.post({ channel: a.channel, threadTs: a.threadTs ?? a.messageTs, text: answered });
        }
        return;
      }
      const win = /^sb_win_(approve|decline|suggest)$/.exec(a.actionId);
      if (win && this.windows) {
        const result = this.windows.decideFromSlackButton({ windowId: String(value['w']), slackUserId: a.user, decision: win[1] as 'approve' | 'decline' | 'suggest' });
        // The mirror rewrites the window's own card with the decision (windowUpdate). A card the ops agent re-posted
        // (request_approval) is rewritten here, so its buttons go too.
        if (result.final && a.messageTs !== this.core.thread(String(value['w']))?.slack_ts) {
          await this.port.update({ channel: a.channel, ts: a.messageTs, ...card(escapeSlack(result.text)) });
        } else if (!result.final) await tell(result.text);
        return;
      }
      const std = /^sb_std_(approve|decline|revoke)$/.exec(a.actionId);
      if (std && this.windows) {
        // The mirror rewrites the card with the decision (standingCard).
        this.windows.decideStandingFromSlackButton({ cardId: Number(value['k']), slackUserId: a.user, decision: std[1] as StandingDecision });
        return;
      }
      return tell('Unknown button.');
    } catch (err) {
      if (err instanceof SwitchboardError) return tell(err.message);
      throw err;
    }
  }
}

// ---- the Bolt adapter (Socket Mode: no public ingress, P4) ----

const HUMAN_SUBTYPES = new Set(['thread_broadcast', 'file_share']);

export class BoltSlack implements SlackPort {
  readonly app: bolt.App;
  botUserId = '';

  constructor(botToken: string, appToken: string) {
    // Bolt's default client never times out and retries for about 30 minutes. A post during a Slack outage
    // should fail within seconds and leave the catching up to sweep(): the mirror is durable.
    this.app = new bolt.App({ token: botToken, appToken, socketMode: true, logLevel: bolt.LogLevel.WARN,
      clientOptions: { timeout: 10_000, retryConfig: { retries: 2, factor: 2 } } });
  }

  /** Learns the bot's own user id. Call before building the bridge. */
  async connect(): Promise<string> {
    const auth = await this.app.client.auth.test();
    return (this.botUserId = String(auth.user_id));
  }

  async start(bridge: SlackBridge): Promise<void> {
    const inbound = () => bridge;
    this.app.event('message', async ({ event }) => {
      const m = event as { subtype?: string; bot_id?: string; channel: string; channel_type: string; user?: string; text?: string; ts: string; thread_ts?: string };
      // A human message with a file or screenshot arrives as subtype file_share; edits, joins and bots are skipped.
      if ((m.subtype && !HUMAN_SUBTYPES.has(m.subtype)) || m.bot_id || !m.user) return;
      await inbound().onMessage({ channel: m.channel, channelType: m.channel_type, user: m.user, text: m.text ?? '', ts: m.ts, ...(m.thread_ts ? { threadTs: m.thread_ts } : {}) });
    });
    this.app.action(/^sb_/, async ({ ack, body, action }) => {
      await ack();
      const b = body as { user: { id: string }; channel?: { id: string }; message?: { ts: string; thread_ts?: string } };
      const act = action as { action_id: string; value?: string };
      if (!b.channel || !b.message) return;
      await inbound().onAction({ actionId: act.action_id, value: act.value ?? '', user: b.user.id, channel: b.channel.id, messageTs: b.message.ts,
        ...(b.message.thread_ts ? { threadTs: b.message.thread_ts } : {}) });
    });
    await this.app.start();
  }

  async stop(): Promise<void> { await this.app.stop(); }

  async post(msg: SlackPost): Promise<{ channel: string; ts: string }> {
    const r = await this.app.client.chat.postMessage({ channel: msg.channel, text: msg.text, ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}),
      ...(msg.blocks ? { blocks: msg.blocks as never } : {}), unfurl_links: false, unfurl_media: false });
    return { channel: String(r.channel), ts: String(r.ts) };
  }
  async update(msg: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<void> {
    await this.app.client.chat.update({ channel: msg.channel, ts: msg.ts, text: msg.text, blocks: (msg.blocks ?? []) as never });
  }
  async ephemeral(msg: { channel: string; user: string; text: string; threadTs?: string }): Promise<void> {
    await this.app.client.chat.postEphemeral({ channel: msg.channel, user: msg.user, text: msg.text, ...(msg.threadTs ? { thread_ts: msg.threadTs } : {}) });
  }
  async openDm(slackUserId: string): Promise<string> {
    const r = await this.app.client.conversations.open({ users: slackUserId });
    return String(r.channel?.id);
  }
}
