// Maintenance windows (plan §11) and the M2 acceptance test: a window reaches `approved` only through
// the Slack button handler, pressed by a Slack user who is an allowed approver.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createAgentHttpServer } from '../src/agent-mcp.ts';
import { type ClientHints, Core, SwitchboardError } from '../src/core.ts';
import { MIGRATIONS, openDb } from '../src/db.ts';
import { listen } from '../src/main.ts';
import { SlackBridge } from '../src/slack.ts';
import { type Resource, Windows, titleFrom } from '../src/windows.ts';
import { FakeSlack, RESOURCES, SLACK, buttonValue, call, hint, mcpClient, tempDir, world } from './fakes.ts';


function setup(maintenance?: { start: string; duration_minutes: number }) {
  const w = world();
  const windows = new Windows(w.core, RESOURCES, maintenance ? { maintenance } : {});
  const slack = new FakeSlack();
  const bridge = new SlackBridge({ core: w.core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot, windows });
  bridge.start();
  const ask = (resource = 'api-gateway', minutes = 30, start = '2026-10-14T14:00:00Z') =>
    windows.request(w.agents.scout, { resource, start, duration_minutes: minutes, plan: 'bump gateway', rollback: 'redeploy v1', verify: 'curl /health' });
  const press = (id: string, user: string, decision: 'approve' | 'decline' | 'suggest' = 'approve') =>
    bridge.onAction({ actionId: `sb_win_${decision}`, value: JSON.stringify({ w: id }), user, channel: SLACK.ops, messageTs: '9.9' });
  const settle = async () => { for (let i = 0; i < 3; i++) await bridge.sweep(); };
  /** Presses a button on `approver`'s newest card for `version` (a card that doesn't exist: id 0). */
  const standing = (version: number, approver: string, user: string, decision: 'approve' | 'decline' | 'revoke' = 'approve', messageTs = '8.8') => {
    const card = w.core.db.prepare('SELECT id FROM standing_cards WHERE version = ? AND approver = ? ORDER BY id DESC LIMIT 1').get(version, approver) as { id: number } | undefined;
    return bridge.onAction({ actionId: `sb_std_${decision}`, value: JSON.stringify({ k: card?.id ?? 0 }), user, channel: SLACK.ops, messageTs });
  };
  const count = (table: string) => (w.core.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...w, windows, slack, bridge, ask, press, settle, standing, count };
}

const errCode = (fn: () => unknown): string => {
  try { fn(); } catch (err) { if (err instanceof SwitchboardError) return err.code; throw err; }
  return 'ok';
};

/** The titles migration 10 gives windows with these plans, in a v9 DB like the live one. */
function migratedTitles(plans: string[]): string[] {
  const path = join(tempDir('sb-titles-'), 'switchboard.db');
  const v9 = new DatabaseSync(path);
  for (const m of MIGRATIONS.slice(0, 9)) v9.exec(m);
  v9.exec('PRAGMA user_version = 9');
  v9.exec("INSERT INTO principals VALUES ('alice', 'Alice', NULL, 'x'); INSERT INTO agents (id, principal_id, name, created_at) VALUES ('alice/claude', 'alice', 'claude', 'x');" +
    "INSERT INTO resources VALUES ('r', 'R', '[\"alice\"]', '{}', 'x');");
  plans.forEach((plan, i) => {
    const id = `w_${String(i).padStart(12, '0')}`;
    v9.prepare("INSERT INTO threads (id, kind, visibility, title, created_at) VALUES (?, 'window', 'shared', 'w', 'x')").run(id);
    v9.prepare(`INSERT INTO windows (id, resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all, state, created_at)
      VALUES (?, 'r', 'alice/claude', '2026-10-18T13:00:00.000Z', '2026-10-18T14:00:00.000Z', ?, 'r', 'v', '["alice"]', 0, 'proposed', 'x')`).run(id, plan);
  });
  v9.close();
  const db = openDb(path);
  const titles = (db.prepare('SELECT title FROM windows ORDER BY id').all() as Array<{ title: string }>).map((r) => r.title);
  db.close();
  return titles;
}
const PLAN_SHAPES = [
  '1. Stop the engine. 2. Deploy the new build. 3. Start it.',
  '12) Deploy frontend v2.1.3 to prod. Then watch the logs.',
  '- restart the gateway\n- check /health',
  '* drain the queue. Then restart',
  '• rotate the API keys on web-prod-1',
  'e.g. bump the rate limits on web-prod-1. Then restart the service.',
  'Fix it. Then deploy the new build to prod.',
  'Is the box idle? If so, reboot it.',
  '1234. not a list marker. Really',
  '- ',
  '...',
  '\u00a0\u00a0Deploy the gateway build now. Then x',
  'Rotate the keys\u00a0on box 1. Then restart',
  `${'a'.repeat(78)}😀😀😀 tail`,
  `${'😀'.repeat(10)} fix. then more`,
];

describe('request_window', () => {
  test('creates a shared window thread with every owner, and posts approval buttons tagging the approver', async () => {
    const { ask, core, slack, settle } = setup();
    const r = ask();
    const thread = core.thread(r.window)!;
    assert.equal(thread.kind, 'window');
    assert.equal(thread.visibility, 'shared');
    assert.ok(core.isParticipant(r.window, 'principal:alice') && core.isParticipant(r.window, 'principal:bob'));
    assert.deepEqual(r.approvers, ['bob']);
    await settle();
    const msg = slack.posts.find((p) => p.blocks)!;
    // P2: one line that tags who must approve, with the resource, time, title, requester and the standing rule.
    assert.equal(msg.text, `:wrench: <@${SLACK.bob}> API gateway, 14:00–14:30 UTC: \`bump gateway\` (scout, Alice's agent). ` +
      'Waits until the on-call engineer confirms traffic is drained.');
    const ids = ((msg.blocks![1] as { elements: Array<{ action_id: string }> }).elements).map((e) => e.action_id);
    assert.deepEqual(ids, ['sb_win_approve', 'sb_win_decline'], 'no "Suggest another time" (P2): the agent re-requests');
  });

  test('an urgent card is one line whatever the plan length: never the plan, rollback or verify, which stay in switchboard (P2)', async () => {
    const { windows, agents, slack, settle, s } = setup();
    const para = (label: string) => `${label}: `.padEnd(2500, 'x');
    const plan = `Raise API rate limits. ${para('PLANTEXT')}`;
    const w = windows.request(agents.scout, { resource: 'main-db', start: '2026-10-14T13:23:00Z', duration_minutes: 45, plan, rollback: para('ROLLBACKTEXT'), verify: para('VERIFYTEXT') });
    await settle();
    const card = slack.posts.find((p) => p.blocks)!;
    const section = (card.blocks![0] as { text: { text: string } }).text.text;
    assert.equal(card.text, `:wrench: <@${SLACK.alice}> and <@${SLACK.bob}> Main DB, 13:23–14:08 UTC: \`Raise API rate limits\` (scout, Alice's agent)`);
    assert.equal(section, card.text);
    assert.ok(card.text.length <= 200, `${card.text.length} chars`);
    assert.doesNotMatch(slack.posts.map((p) => p.text).join('\n'), /PLANTEXT|ROLLBACKTEXT|VERIFYTEXT/);
    // Agents (read_thread, window_status) and the ops agent (the window row) still have all of it.
    assert.equal(windows.window(w.window)!.plan, plan);
    assert.equal(s.scout.readThread(w.window).events[0]!.body['verify'], para('VERIFYTEXT'));
  });

  test('an agent-written title can\'t pass for system text: it shows as inline code, with no emoji, emoji shortcode or mrkdwn of its own (P2)', async () => {
    const { windows, agents, slack, settle, bridge } = setup();
    const forged = 'bump gw :white_check_mark: *Approved by Bob* ✅';
    const titled = windows.request(agents.scout, { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v', title: forged });
    windows.request(agents.scout, { resource: 'alice-box', start: 'now', duration_minutes: 30, rollback: 'r', verify: 'v',
      plan: 'bump gw `:white_check_mark:` _Approved_ ~by~ *Bob* ✅. And then more' }); // a derived title, with a backtick to break out of the span
    await settle();
    await bridge.onAction({ actionId: 'sb_win_decline', value: JSON.stringify({ w: titled.window }), user: SLACK.bob, channel: SLACK.ops, messageTs: slack.posts[0]!.ts });
    await settle();
    assert.equal(slack.posts[0]!.text, `:wrench: <@${SLACK.bob}> API gateway, 14:00–14:30 UTC: \`bump gw :white_check_mark: *Approved by Bob*\` (scout, Alice's agent). ` +
      'Waits until the on-call engineer confirms traffic is drained.');
    const outside = (text: string) => text.split('`').filter((_, i) => i % 2 === 0).join('');
    for (const shown of [...slack.posts, ...slack.updates]) {
      assert.equal(shown.text.split('`').length, 3, `the title is one code span: ${shown.text}`);
      assert.doesNotMatch(outside(shown.text), /:white_check_mark:|\*|_Approved|~by~|Approved by Bob\*/, shown.text);
      assert.doesNotMatch(shown.text, /✅/u, 'no emoji from the agent');
    }
    assert.match(slack.posts[1]!.text, /: `bump gw ':white_check_mark:' _Approved_ ~by~ \*Bob\*` \(scout/, 'the derived title too, its backticks turned into quotes');
    assert.match(slack.updates.at(-1)!.text, /^:no_entry: API gateway, 14:00–14:30 UTC: `bump gw :white_check_mark: \*Approved by Bob\*`\. Declined by Bob\.$/);
  });

  test('a derived title skips a list marker and a sentence end in the first 15 characters, the same in titleFrom and in migration 10 (P2)', () => {
    assert.deepEqual(PLAN_SHAPES.map(titleFrom), [
      'Stop the engine',
      'Deploy frontend v2.1.3 to prod',
      'restart the gateway',
      'drain the queue',
      'rotate the API keys on web-prod-1',
      'e.g. bump the rate limits on web-prod-1',
      'Fix it. Then deploy the new build to prod',
      'Is the box idle',
      '1234. not a list marker',
      '-',
      'maintenance',
      'Deploy the gateway build now',
      'Rotate the keys on box 1',
      `${'a'.repeat(78)}😀…`,
      `${'😀'.repeat(10)} fix. then more`,
    ]);
    for (const title of PLAN_SHAPES.map(titleFrom)) assert.ok(title.isWellFormed(), `no emoji cut in half: ${JSON.stringify(title)}`);
    assert.deepEqual(migratedTitles(PLAN_SHAPES), PLAN_SHAPES.map(titleFrom), 'the SQL backfill and titleFrom agree on every shape');
  });

  test('request_window says which title its card shows, and asks for one when the derived title says little (P2)', () => {
    const { windows, agents } = setup();
    const req = (plan: string, title?: string) => windows.request(agents.scout, { resource: 'alice-box', start: 'now', duration_minutes: 30, plan, rollback: 'r', verify: 'v', ...(title ? { title } : {}) });
    const derived = req('Raise API rate limits to 2x. Restart the engine after.');
    assert.equal(derived.title, 'Raise API rate limits to 2x');
    assert.match(derived.title_note!, /^No title given, so the card shows "Raise API rate limits to 2x" \(your plan's first sentence\)\. Pass title/);
    assert.match(req('Deploy.').title_note!, /the card shows only "Deploy", which says little about the change\. Pass title on an urgent request: one short line for the humans, e\.g\. 'raise API rate limits'\./);
    assert.match(req(`${'a'.repeat(120)}`).title_note!, /says little/, 'clipped');
    assert.equal(req('anything', 'raise API rate limits').title_note, undefined, 'given: nothing to say');
  });

  test('request_window takes a short title, else derives one from the plan\'s first sentence; a title is fixed once requested (P2)', async () => {
    const { windows, agents, core, slack, settle } = setup();
    const req = (extra: Record<string, unknown>, plan = 'Raise API rate limits to 2x. Restart the engine after.') =>
      windows.request(agents.scout, { resource: 'alice-box', start: 'now', duration_minutes: 30, plan, rollback: 'r', verify: 'v', ...extra });
    const titled = req({ title: '  raise   API rate limits ' });
    assert.equal(titled.title, 'raise API rate limits');
    assert.equal(windows.window(titled.window)!.title, 'raise API rate limits');
    const st = windows.status(agents.scout, { id: titled.window });
    assert.ok('title' in st);
    assert.equal(st.title, 'raise API rate limits', 'window_status has it');
    assert.equal(req({}).title, 'Raise API rate limits to 2x', 'the plan\'s first sentence');
    assert.equal(req({}, `${'a'.repeat(200)}. second`).title, `${'a'.repeat(79)}…`, 'clipped to 80 characters');
    assert.equal(req({}, 'Bump v2.1.3 on frontend\nthen restart').title, 'Bump v2.1.3 on frontend', 'one line');
    assert.throws(() => req({ title: 'x'.repeat(81) }), (e: unknown) => e instanceof SwitchboardError && e.code === 'invalid' && /at most 80 characters/.test(e.message));
    assert.throws(() => req({ title: '   ' }), (e: unknown) => e instanceof SwitchboardError && e.code === 'invalid');
    assert.throws(() => core.db.prepare("UPDATE windows SET title = 'something else' WHERE id = ?").run(titled.window), /fixed once requested/, 'the title is what the approver saw');
    await settle();
    assert.match(slack.posts[0]!.text, /Alice's staging box, 12:00–12:30 UTC: `raise API rate limits` \(scout, Alice's agent\)$/);
  });

  test('rejects non-owners, bad times, too long, and overlaps with approved windows', async () => {
    const { windows, agents, ask, press } = setup();
    assert.equal(errCode(() => windows.request(agents.helper, { resource: 'alice-box', start: 'now', duration_minutes: 5, plan: 'p', rollback: 'r', verify: 'v' })), 'forbidden');
    assert.equal(errCode(() => ask('api-gateway', 30, 'tomorrow-ish')), 'invalid');
    assert.equal(errCode(() => ask('api-gateway', 30, '2026-10-14T10:00:00Z')), 'invalid');
    assert.equal(errCode(() => ask('api-gateway', 121)), 'invalid');
    assert.equal(errCode(() => ask('nope')), 'not_found');
    const first = ask();
    const second = ask('api-gateway', 30, '2026-10-14T14:15:00Z');
    assert.deepEqual(second.also_proposed_for_this_slot, [first.window], 'overlapping proposals are allowed but flagged');
    await press(first.window, SLACK.bob);
    assert.equal(errCode(() => ask('api-gateway', 30, '2026-10-14T14:20:00Z')), 'conflict');
    assert.equal(ask('api-gateway', 30, '2026-10-14T14:30:00Z').state, 'proposed', 'back-to-back is fine');
  });

  test('a start without Z or a UTC offset is refused, not read in the host\'s timezone', () => {
    const { ask, windows, agents } = setup();
    for (const bad of ['2026-10-14T16:00:00', '2026-10-14 16:00', '2026-10-15']) {
      assert.throws(() => ask('api-gateway', 30, bad), (e: unknown) => e instanceof SwitchboardError && e.code === 'invalid' && /UTC offset/.test(e.message), bad);
    }
    assert.equal(ask('api-gateway', 30, '2026-10-14T18:00:00+02:00').start, '2026-10-14T16:00:00.000Z');
    assert.equal(ask('api-gateway', 30, '2026-10-14T17:00:00Z').start, '2026-10-14T17:00:00.000Z');
    assert.equal(windows.request(agents.scout, { resource: 'alice-box', start: 'now', duration_minutes: 5, plan: 'p', rollback: 'r', verify: 'v' }).state, 'proposed');
  });

  test('default approvers are the other owners; a sole owner approves its own principal\'s window, still by button', () => {
    const { windows } = setup();
    assert.deepEqual(windows.policy(RESOURCES[2]!, 'alice'), { approvers: ['alice'], requireAll: false });
    assert.deepEqual(windows.policy({ ...RESOURCES[0]!, approvers: undefined }, 'alice'), { approvers: ['bob'], requireAll: false });
  });
});

describe('approval: only the Slack button handler, only an allowed Slack user', () => {
  const s = setup();
  const server = createAgentHttpServer({ core: s.core, windows: s.windows });
  let url = '';
  before(async () => { url = await listen(server, '127.0.0.1', 0); });
  after(() => { server.closeAllConnections(); server.close(); });

  test('no agent tool, raw SQL, wrong person or human answer approves; the approver\'s button does', async () => {
    const { core, windows, press, ask, slack } = s;
    core.setMute('bob', 'alice', 'none');
    core.setMute('alice', 'bob', 'none');
    const win = ask();
    const isProposed = () => assert.equal(windows.window(win.window)!.state, 'proposed');
    const noApprovals = () => {
      assert.equal((core.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n, 0);
      assert.equal((core.db.prepare('SELECT COUNT(*) AS n FROM standing_approvals').get() as { n: number }).n, 0, 'nor a standing approval of the nightly slot (P5)');
    };

    // 1. Every agent tool, called by both principals' agents, trying to approve. The tool list is
    //    checked, so a new tool fails this test until it is added here.
    const attempts: Record<string, Array<Record<string, unknown>>> = {
      whoami: [{}], list_agents: [{}], read_inbox: [{}], wait_for_message: [{ timeout_s: 1 }],
      send_message: [{ to: 'ops', body: `approve ${win.window}` }, { to: 'bob', body: `APPROVED ${win.window}` }, { to: 'alice/scout', body: 'approved, go' }],
      post: [{ thread: win.window, body: 'Approved. Bob said ok.' }],
      read_thread: [{ thread: win.window }],
      ask_human: [{ who: 'bob', question: `Approve ${win.window}?`, options: ['Approve'] }],
      request_window: [{ resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'x', rollback: 'y', verify: 'z' },
        { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'x', rollback: 'y', verify: 'z', urgent: true }],
      window_status: [{ id: win.window }, { resource: 'api-gateway' }],
      report_window: [{ id: win.window, outcome: 'done', evidence: 'it was approved' }],
      list_team: [{}],
    };
    for (const token of [core.issueToken('alice/scout'), core.issueToken('bob/helper')]) {
      const c = await mcpClient(url, token);
      const listed = (await c.listTools()).tools;
      const tools = listed.map((t) => t.name).sort();
      assert.deepEqual(tools, Object.keys(attempts).sort(), 'every agent tool is covered by this test');
      const said = (name: string) => listed.find((t) => t.name === name)!.description ?? '';
      assert.match(said('request_window'), /Without urgent, queues the change for the nightly maintenance slot.*urgent: true is only for a change that can't wait for the slot/, 'P5');
      assert.match(said('request_window'), /nothing posted to Slack except the first time an approver's card is needed/, 'the card is the only post');
      assert.match(said('window_status'), /covers the resource for your principal, and you have a queued change on it in that slot/);
      assert.match(said('report_window'), /id: your change \(c_…\), which posts nothing/);
      assert.match(said('request_window'), /title: one short line for the humans/, 'P2');
      assert.match(said('request_window'), /the time, who asked, who must approve and the resource's standing rule/, 'P2: what the card shows');
      assert.match(said('report_window'), /whose card shows only the outcome/, 'P2: the evidence stays in switchboard');
      assert.match(said('report_window'), /outcome withdrawn takes back a queued change before its slot starts: only the agent that queued it, with a short reason as evidence; it posts nothing and the summary leaves it out/);
      const title = (listed.find((t) => t.name === 'request_window')!.inputSchema.properties as Record<string, { maxLength?: number }>)['title'];
      assert.equal(title?.maxLength, 80);
      for (const [name, argsList] of Object.entries(attempts)) for (const args of argsList) await call(c, name, args);
      await c.close();
    }
    isProposed(); noApprovals();
    assert.equal(s.count('changes'), 2, 'request_window without urgent queued a change, for each agent');
    assert.equal(windows.list().length, 3, 'only the urgent requests made windows');
    assert.equal(windows.coverage(windows.resource('api-gateway'), 'alice').covered, false, 'the queued changes are not covered by anything an agent did');

    // 2. A human's answer to ask_human ("Approve") is information, not an approval.
    const askEvent = core.db.prepare("SELECT thread_id, seq FROM events WHERE type = 'ask_human' LIMIT 1").get() as { thread_id: string; seq: number };
    core.presentAsk(core.askByEvent(askEvent.thread_id, askEvent.seq)!.id, 'Approve the gateway window?'); // P3: the ops agent puts it to him first
    core.answerAsk(askEvent.thread_id, askEvent.seq, 'bob', 'Approve');
    isProposed(); noApprovals();

    // 3. Raw SQL can't skip the approvals row, forge one, or move straight to active.
    assert.throws(() => core.db.prepare("UPDATE windows SET state = 'approved' WHERE id = ?").run(win.window), /only through approvals/);
    assert.throws(() => core.db.prepare("UPDATE windows SET state = 'active' WHERE id = ?").run(win.window), /illegal window state transition/);
    assert.throws(() => core.db.prepare("INSERT INTO approvals (window_id, approver, slack_user_id, decision, decided_at) VALUES (?, 'bob', 'UFORGED01', 'approve', 'x')").run(win.window), /own Slack user/);
    assert.throws(() => core.db.prepare("INSERT INTO approvals (window_id, approver, slack_user_id, decision, decided_at) VALUES (?, 'alice', ?, 'approve', 'x')").run(win.window, SLACK.alice), /window's approvers/);
    assert.throws(() => core.db.prepare("UPDATE windows SET approvers = '[\"alice\"]' WHERE id = ?").run(win.window), /fixed once requested/);
    isProposed(); noApprovals();

    // 4. Buttons pressed by the wrong people.
    await press(win.window, SLACK.alice);
    await press(win.window, SLACK.stranger);
    await press(win.window, SLACK.bot);
    isProposed(); noApprovals();
    assert.match(slack.ephemerals.at(-3)!.text, /Alice can't decide windows on API gateway/);

    // 5. The allowed approver's button.
    await press(win.window, SLACK.bob);
    assert.equal(windows.window(win.window)!.state, 'approved');
    const rows = core.db.prepare('SELECT approver, slack_user_id, decision FROM approvals').all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ approver: 'bob', slack_user_id: SLACK.bob, decision: 'approve' }]);
    assert.match(slack.updates.at(-1)!.text, /Approved by Bob/);
    assert.equal(s.s.scout.readInbox().filter((i) => i.type === 'window_decision')[0]!.inbox_priority, 'steer');
  });
});

describe('decisions', () => {
  test('require: all needs every approver; one is not enough', async () => {
    const { ask, press, windows } = setup();
    const w = ask('main-db', 30);
    await press(w.window, SLACK.bob);
    assert.equal(windows.window(w.window)!.state, 'proposed');
    assert.equal(errCode(() => windows.decideFromSlackButton({ windowId: w.window, slackUserId: SLACK.bob, decision: 'approve' })), 'conflict', 'no double counting');
    await press(w.window, SLACK.alice);
    assert.equal(windows.window(w.window)!.state, 'approved');
  });

  test('decline is final; suggest only asks for another time', async () => {
    const { ask, press, windows, s } = setup();
    const w = ask();
    await press(w.window, SLACK.bob, 'suggest');
    assert.equal(windows.window(w.window)!.state, 'proposed');
    await press(w.window, SLACK.bob, 'decline');
    assert.equal(windows.window(w.window)!.state, 'declined');
    assert.equal(errCode(() => windows.decideFromSlackButton({ windowId: w.window, slackUserId: SLACK.bob, decision: 'approve' })), 'conflict');
    assert.deepEqual(s.scout.readInbox().map((i) => i.body['decision']), ['suggest', 'decline']);
  });

  test('a stale Approve pressed after a proposed window ended is refused, before the tick expires it', async () => {
    const { ask, windows, clock, press, slack } = setup();
    const w = ask(); // 14:00–14:30
    clock.advance(151); // 14:31
    assert.equal(errCode(() => windows.decideFromSlackButton({ windowId: w.window, slackUserId: SLACK.bob, decision: 'approve' })), 'conflict');
    await press(w.window, SLACK.bob);
    assert.match(slack.ephemerals.at(-1)!.text, /ended/);
    assert.equal(windows.window(w.window)!.state, 'proposed');
    assert.equal((windows.core.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n, 0);
  });

  test('approval re-checks conflicts: two overlapping proposals can\'t both be approved', async () => {
    const { ask, press, windows } = setup();
    const a = ask();
    const b = ask('api-gateway', 30, '2026-10-14T14:10:00Z');
    await press(a.window, SLACK.bob);
    assert.equal(errCode(() => windows.decideFromSlackButton({ windowId: b.window, slackUserId: SLACK.bob, decision: 'approve' })), 'conflict');
    assert.equal(windows.window(b.window)!.state, 'proposed');
  });
});

describe('an urgent window in Slack is one card (P5)', () => {
  const actions = (blocks?: Array<Record<string, unknown>>) => (blocks ?? []).filter((b) => b['type'] === 'actions');

  test('its decision, start, end and report rewrite the card in place; only the overdue page is a reply', async () => {
    const { ask, windows, clock, agents, slack, settle, bridge } = setup();
    const w = ask();
    await settle();
    assert.equal(slack.posts.length, 1);
    const card = slack.posts[0]!;
    await bridge.onAction({ actionId: 'sb_win_approve', value: JSON.stringify({ w: w.window }), user: SLACK.bob, channel: SLACK.ops, messageTs: card.ts });
    await settle();
    const last = () => slack.updates.at(-1)!;
    assert.equal(slack.posts.length, 1, 'the decision is not a post of its own');
    assert.equal(last().ts, card.ts);
    assert.equal(last().text, ':white_check_mark: API gateway, 14:00–14:30 UTC: `bump gateway`. Approved by Bob.', 'one line (P2)');
    assert.deepEqual(actions(last().blocks), [], 'the buttons are gone');

    clock.advance(110); // 13:50: no T-10 reminder
    assert.deepEqual(windows.tick(), []);
    clock.advance(10); // 14:00
    windows.tick();
    await settle();
    assert.equal(last().text, ':construction: API gateway, 14:00–14:30 UTC: `bump gateway`. In progress until 14:30.');
    clock.advance(30); // 14:30
    windows.tick();
    await settle();
    assert.equal(last().text, ':hourglass_flowing_sand: API gateway, 14:00–14:30 UTC: `bump gateway`. Ended, waiting for the report.');
    assert.equal(slack.posts.length, 1, 'start and end rewrite the card too');

    clock.advance(30); // 15:00 = end + grace
    windows.tick();
    await settle();
    assert.equal(slack.posts.length, 2);
    assert.equal(slack.posts[1]!.threadTs, card.ts, 'the overdue page is a reply under the card');
    assert.match(slack.posts[1]!.text, new RegExp(`^<@${SLACK.alice}>: \\*scout\\* \\(Alice's agent\\) hasn't reported`));

    windows.report(agents.scout, { id: w.window, outcome: 'rolled_back', evidence: 'curl /health → 503, rolled back to v1' });
    await settle();
    assert.equal(slack.posts.length, 2);
    assert.equal(last().ts, card.ts);
    assert.equal(last().text, ':leftwards_arrow_with_hook: API gateway, 14:00–14:30 UTC: `bump gateway`. Rolled back.', 'the outcome in one word, never the evidence (P2)');
    assert.doesNotMatch([...slack.posts, ...slack.updates].map((p) => p.text).join('\n'), /curl|503|rolled back to v1|redeploy v1/, 'neither evidence nor verify nor rollback reach Slack');
    for (const u of slack.updates) assert.equal((u.blocks ?? []).at(-1)?.['type'], 'context', 'every rewrite keeps the switchboard footer');
  });

  test('a failed report says so on the card and in one short reply that tags the requester\'s human, without the evidence (P2)', async () => {
    const { ask, press, windows, clock, agents, slack, settle } = setup();
    const w = ask();
    await press(w.window, SLACK.bob);
    clock.advance(125); // 14:05
    windows.tick();
    await settle();
    const card = slack.posts[0]!;
    windows.report(agents.builder, { id: w.window, outcome: 'failed', evidence: 'EVIDENCE: gateway wedged, health 503 for 4 min' });
    await settle();
    assert.equal(slack.updates.at(-1)!.ts, card.ts);
    assert.equal(slack.updates.at(-1)!.text, ':x: API gateway, 14:00–14:30 UTC: `bump gateway`. Failed.');
    assert.deepEqual(slack.posts.slice(1).map((p) => [p.threadTs, p.text]), [[card.ts, `<@${SLACK.alice}>: *builder* (Alice's agent) reported a failed change on *API gateway*. Is prod in a known state?`]]);
    assert.equal((slack.posts[1]!.blocks ?? []).at(-1)?.['type'], 'context', 'a system reply with the footer');
    assert.doesNotMatch([...slack.posts, ...slack.updates].map((p) => p.text).join('\n'), /EVIDENCE|wedged/);
  });

  test('a card Slack can no longer edit gets the change posted under it; a transient failure waits for the sweep', async () => {
    const { ask, slack, settle, bridge, core } = setup();
    const w = ask();
    await settle();
    const card = slack.posts[0]!;
    const update = slack.update.bind(slack);
    let failure = 'ratelimited';
    slack.update = async (msg) => { if (failure) throw Object.assign(new Error(`An API error occurred: ${failure}`), { data: { ok: false, error: failure } }); return update(msg); };
    await bridge.onAction({ actionId: 'sb_win_approve', value: JSON.stringify({ w: w.window }), user: SLACK.bob, channel: SLACK.ops, messageTs: card.ts });
    await settle();
    assert.equal(slack.posts.length, 1, 'a rate limit: nothing posted yet');
    assert.ok(core.thread(w.window)!.slack_synced_seq < core.events(w.window).at(-1)!.seq, 'the sweep still has it');
    failure = 'cant_update_message';
    await settle();
    assert.deepEqual(slack.posts.slice(1).map((p) => [p.threadTs, /Approved by Bob/.test(p.text)]), [[card.ts, true]]);
  });

  test('an expired window\'s card says so in place; a partial approval keeps the buttons', async () => {
    const { ask, windows, clock, slack, settle, bridge } = setup();
    const both = ask('main-db', 30);
    await settle();
    const card = slack.posts[0]!;
    await bridge.onAction({ actionId: 'sb_win_approve', value: JSON.stringify({ w: both.window }), user: SLACK.bob, channel: SLACK.ops, messageTs: card.ts });
    await settle();
    assert.equal(slack.updates.at(-1)!.text, ':wrench: Main DB, 14:00–14:30 UTC: `bump gateway` (scout, Alice\'s agent). Approved by Bob; waiting for Alice.');
    assert.equal(actions(slack.updates.at(-1)!.blocks).length, 1, 'the others still decide on this card');
    clock.advance(150);
    windows.tick();
    await settle();
    assert.equal(slack.posts.length, 1);
    assert.equal(slack.updates.at(-1)!.text, ':heavy_minus_sign: Main DB, 14:00–14:30 UTC: `bump gateway`. Expired, not approved.');
    assert.deepEqual(actions(slack.updates.at(-1)!.blocks), []);
  });

  test('a stale Suggest press on an approved window changes nothing: its card keeps the approved line, without buttons (P2)', async () => {
    const { ask, slack, settle, bridge, windows, core } = setup();
    const w = ask();
    await settle();
    const card = slack.posts[0]!;
    const press = (decision: string) => bridge.onAction({ actionId: `sb_win_${decision}`, value: JSON.stringify({ w: w.window }), user: SLACK.bob, channel: SLACK.ops, messageTs: card.ts });
    await press('approve');
    await settle();
    const approved = slack.updates.at(-1)!;
    const events = core.events(w.window).length;
    await press('suggest'); // a button on an older card, which still offered it
    await settle();
    assert.equal(windows.window(w.window)!.state, 'approved');
    assert.equal(core.events(w.window).length, events, 'nothing recorded');
    assert.equal(slack.updates.at(-1), approved, 'the card is left as it is');
    assert.match(slack.ephemerals.at(-1)!.text, /already approved/);
    // One recorded before this fix doesn't reopen the card either, live or on a re-render.
    core.append(w.window, 'principal:bob', 'window_decision', { window: w.window, decision: 'suggest', by: 'bob', state: 'approved', requested_by: 'alice/scout' });
    await settle();
    assert.equal(slack.updates.at(-1), approved);
    windows.rerenderCards();
    await settle();
    assert.equal(slack.updates.at(-1)!.text, ':white_check_mark: API gateway, 14:00–14:30 UTC: `bump gateway`. Approved by Bob.');
    assert.deepEqual(actions(slack.updates.at(-1)!.blocks), []);
  });

  test('a declined card says who declined, in one line without buttons; a window on another day names its date (P2)', async () => {
    const { ask, slack, settle, press } = setup();
    const w = ask('api-gateway', 30, '2026-10-16T09:00:00Z');
    await settle();
    assert.match(slack.posts[0]!.text, /API gateway, Oct 16 09:00–09:30 UTC: `bump gateway`/);
    await press(w.window, SLACK.bob, 'decline');
    await settle();
    assert.equal(slack.updates.at(-1)!.text, ':no_entry: API gateway, Oct 16 09:00–09:30 UTC: `bump gateway`. Declined by Bob.');
    assert.deepEqual(actions(slack.updates.at(-1)!.blocks), []);
  });
});

describe('the clock', () => {
  test('start, end, overdue page, each once; window_status says when to proceed', async () => {
    const { ask, press, windows, clock, agents, slack, settle, s } = setup();
    const w = ask();
    await press(w.window, SLACK.bob);
    assert.equal(windows.status(agents.scout, { resource: 'api-gateway' }).may_proceed, false, 'approved is not active');
    clock.advance(110); // 13:50
    assert.deepEqual(windows.tick(), [], 'no T-10 reminder (P5)');
    clock.advance(10); // 14:00
    assert.deepEqual(windows.tick().map((e) => e.body['state']), ['active']);
    assert.equal(windows.status(agents.scout, { resource: 'api-gateway' }).may_proceed, true);
    assert.equal(windows.status(agents.builder, { id: w.window }).may_proceed, true, 'any agent of the requesting principal');
    assert.equal(windows.status(agents.helper, { id: w.window }).may_proceed, false, 'not the other principal');
    clock.advance(30); // 14:30
    assert.deepEqual(windows.tick().map((e) => e.body['kind']), ['ended']);
    assert.equal(windows.status(agents.scout, { id: w.window }).may_proceed, false);
    clock.advance(30); // 15:00 = end + grace
    assert.deepEqual(windows.tick().map((e) => e.body['kind']), ['overdue']);
    await settle();
    assert.match(slack.textIn(SLACK.ops), new RegExp(`<@${SLACK.alice}>: \\*scout\\* \\(Alice's agent\\) hasn't reported`));
    windows.report(agents.scout, { id: w.window, outcome: 'done', evidence: 'curl /health → 200' });
    assert.equal(windows.window(w.window)!.state, 'done');
    assert.deepEqual(windows.tick(), []);
    assert.ok(s.scout.readInbox().length >= 4);
  });

  test('an unapproved window expires when it ends', () => {
    const { ask, windows, clock } = setup();
    const w = ask();
    clock.advance(150);
    assert.deepEqual(windows.tick().map((e) => e.body['state']), ['expired']);
    assert.equal(windows.window(w.window)!.state, 'expired');
  });

  test('a window whose resource left config.yaml still ticks and can be read', () => {
    const w = world();
    const before = new Windows(w.core, RESOURCES);
    const orphan = before.request(w.agents.scout, { resource: 'alice-box', start: '2026-10-14T12:30:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v' });
    const gw = before.request(w.agents.scout, { resource: 'api-gateway', start: '2026-10-14T13:00:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v' });
    before.decideFromSlackButton({ windowId: gw.window, slackUserId: SLACK.bob, decision: 'approve' });
    const windows = new Windows(w.core, RESOURCES.filter((r) => r.id !== 'alice-box')); // restarted without alice-box
    w.clock.advance(65); // 13:05
    assert.deepEqual(windows.tick().map((e) => [e.thread_id, e.body['state'], e.body['resource_name']]),
      [[orphan.window, 'expired', 'Alice\'s staging box'], [gw.window, 'active', 'API gateway']]);
    assert.match(JSON.stringify(windows.status(w.agents.scout, { id: orphan.window })), /"state":"expired"/, 'window_status still reads it');
  });

  test('one window failing its clock step doesn\'t stop the others', () => {
    const { ask, windows, clock, core } = setup();
    const bad = ask('api-gateway', 30, '2026-10-14T13:00:00Z');
    const good = ask('api-gateway', 30, '2026-10-14T14:00:00Z');
    const append = core.append.bind(core);
    core.append = (...args: Parameters<Core['append']>) => { if (args[0] === bad.window) throw new Error('disk I/O error'); return append(...args); };
    clock.advance(150); // 14:30: both proposed windows have ended unapproved
    assert.deepEqual(windows.tick().map((e) => e.thread_id), [good.window]);
    assert.equal(windows.window(good.window)!.state, 'expired');
    assert.equal(windows.window(bad.window)!.state, 'proposed', 'rolled back; the next tick retries it');
    core.append = append;
    assert.deepEqual(windows.tick().map((e) => e.thread_id), [bad.window]);
  });

  test('report_window: only the requester\'s principal, only when active', async () => {
    const { ask, press, windows, clock, agents } = setup();
    const w = ask();
    assert.equal(errCode(() => windows.report(agents.scout, { id: w.window, outcome: 'done', evidence: 'x' })), 'conflict');
    await press(w.window, SLACK.bob);
    clock.advance(125);
    assert.equal(errCode(() => windows.report(agents.helper, { id: w.window, outcome: 'done', evidence: 'x' })), 'forbidden');
    assert.equal(errCode(() => windows.report(agents.scout, { id: w.window, outcome: 'great', evidence: 'x' })), 'invalid');
    assert.equal(windows.report(agents.scout, { id: w.window, outcome: 'rolled_back', evidence: 'x' }).state, 'done', 'approved + past start reports fine before the tick');
  });
});

describe('the nightly maintenance slot (P5)', () => {
  test('is seeded from config once, at version 1; the slot for a day runs from its start for its duration', () => {
    const { windows, clock, core } = setup({ start: '22:30', duration_minutes: 120 });
    assert.deepEqual({ ...windows.schedule(), created_at: 'x' }, { version: 1, start: '22:30', duration_minutes: 120, set_by: 'config', created_at: 'x' });
    assert.deepEqual(windows.slotFor('2026-10-14'), { day: '2026-10-14', start: '2026-10-14T22:30:00.000Z', end: '2026-10-15T00:30:00.000Z' });
    assert.deepEqual(windows.nextSlot(), { ...windows.slotFor('2026-10-14'), active: false }, 'at 12:00, tonight\'s');
    clock.advance(11 * 60 + 45); // 23:45
    assert.equal(windows.nextSlot().active, true, 'the current one while it runs');
    clock.advance(30); // 00:15 the next day: the slot that started yesterday is still on
    assert.deepEqual(windows.nextSlot(), { ...windows.slotFor('2026-10-14'), active: true });
    clock.advance(30); // 00:45: it ended, so the next one is tonight's
    assert.deepEqual(windows.nextSlot(), { ...windows.slotFor('2026-10-15'), active: false });
    const again = new Windows(core, RESOURCES, { maintenance: { start: '03:00', duration_minutes: 30 } });
    assert.equal(again.schedule().start, '22:30', 'the DB keeps the schedule; config only seeds it');
    assert.deepEqual({ ...new Windows(world().core, RESOURCES).schedule(), created_at: 'x' }, { version: 1, start: '21:00', duration_minutes: 120, set_by: 'config', created_at: 'x' }, 'default 21:00 for 120 min');
  });

  test('a standing approval comes only from its approver\'s own button: no agent, ops, raw SQL or other Slack user; Revoke works', async () => {
    const { windows, slack, settle, standing, count, core } = setup();
    const gateway = windows.resource('api-gateway');
    assert.equal(windows.coverage(gateway, 'alice').covered, false);
    assert.deepEqual(windows.askStanding(['bob']), [{ approver: 'bob', card: 'posted' }]);
    assert.deepEqual(windows.askStanding(['bob']), [{ approver: 'bob', card: 'waiting' }], 'no second card while nothing new needs approving');
    await settle();
    assert.equal(slack.posts.length, 1);
    const card = slack.posts[0]!;
    assert.equal(card.threadTs, undefined, 'a top-level card in #ops');
    // P2: one line; what the approval covers is the card's stored pairs, which list_maintenance shows in full.
    assert.equal(card.text, `:calendar: <@${SLACK.bob}> Nightly maintenance 21:00–23:00 UTC for 2 shared resources (Alice's and Bob's agents). Approve once?`);
    assert.doesNotMatch(card.text, /staging box/, 'only what this approver\'s approval covers');
    assert.deepEqual(windows.maintenance().standing.map((c) => [c.approver, c.covers]), [['bob', [
      'api-gateway for alice\'s agents', 'api-gateway for bob\'s agents', 'main-db for alice\'s agents', 'main-db for bob\'s agents']]], 'the full detail stays in list_maintenance');
    const ids = ((card.blocks!.find((b) => b['type'] === 'actions') as { elements: Array<{ action_id: string }> }).elements).map((e) => e.action_id);
    assert.deepEqual(ids, ['sb_std_approve', 'sb_std_decline']);

    // Raw SQL can't forge one, approve for someone with no card, or edit one.
    const cardId = (core.db.prepare("SELECT id FROM standing_cards WHERE approver = 'bob'").get() as { id: number }).id;
    assert.throws(() => core.db.prepare("INSERT INTO standing_approvals (card_id, approver, slack_user_id, decision, decided_at) VALUES (?, 'bob', 'UFORGED01', 'approve', 'x')").run(cardId), /own Slack user/);
    assert.throws(() => core.db.prepare("INSERT INTO standing_approvals (card_id, approver, slack_user_id, decision, decided_at) VALUES (?, 'alice', ?, 'approve', 'x')").run(cardId, SLACK.alice), /card was posted to/);
    assert.throws(() => core.db.prepare("UPDATE standing_cards SET covers = '[[\"alice-box\",\"alice\"]]'").run(), /fixed once posted/, 'what a card approves never changes');
    // The wrong people's buttons.
    await standing(1, 'bob', SLACK.alice);
    await standing(1, 'bob', SLACK.stranger);
    await standing(1, 'bob', SLACK.bot);
    await standing(1, 'alice', SLACK.alice);
    assert.equal(count('standing_approvals'), 0);
    assert.match(slack.ephemerals[0]!.text, /this card is Bob's/);
    assert.equal(windows.coverage(gateway, 'alice').covered, false);

    await standing(1, 'bob', SLACK.bob, 'approve', card.ts);
    await settle();
    assert.equal(windows.coverage(gateway, 'alice').covered, true, 'require any: Bob\'s approval covers the gateway for Alice\'s agents');
    assert.equal(windows.coverage(gateway, 'bob').covered, true);
    assert.deepEqual(windows.coverage(windows.resource('main-db'), 'alice'), { covered: false, approvers: ['alice', 'bob'], requireAll: true, missing: ['alice'] }, 'require all: Alice must approve too');
    assert.equal(slack.posts.length, 1, 'the decision rewrites the card');
    const approved = slack.updates.at(-1)!;
    assert.equal(approved.ts, card.ts);
    assert.equal(approved.text, ':calendar: Nightly maintenance 21:00–23:00 UTC. Approved by Bob.');
    assert.deepEqual(((approved.blocks!.find((b) => b['type'] === 'actions') as { elements: Array<{ action_id: string }> }).elements).map((e) => e.action_id), ['sb_std_revoke']);
    assert.throws(() => core.db.prepare("UPDATE standing_approvals SET decision = 'revoke'").run(), /append-only/);
    assert.throws(() => core.db.prepare('DELETE FROM standing_approvals').run(), /append-only/);

    await standing(1, 'bob', SLACK.bob, 'revoke', card.ts);
    await settle();
    assert.equal(windows.coverage(gateway, 'alice').covered, false, 'revoked');
    assert.equal(slack.updates.at(-1)!.text, ':calendar: Nightly maintenance 21:00–23:00 UTC. Revoked by Bob.');
    assert.deepEqual(((slack.updates.at(-1)!.blocks!.find((b) => b['type'] === 'actions') as { elements: Array<{ action_id: string }> }).elements).map((e) => e.action_id), ['sb_std_approve'], 'and can approve again');
    assert.deepEqual(core.db.prepare('SELECT approver, slack_user_id, decision FROM standing_approvals ORDER BY id').all().map((r) => ({ ...r })),
      [{ approver: 'bob', slack_user_id: SLACK.bob, decision: 'approve' }, { approver: 'bob', slack_user_id: SLACK.bob, decision: 'revoke' }]);
  });

  test('a standing approval covers only the resource and principal pairs its card listed: a wider config needs a new card for the new pairs', async () => {
    const t = setup();
    t.windows.askStanding(['bob']);
    await t.settle();
    await t.standing(1, 'bob', SLACK.bob, 'approve', t.slack.posts[0]!.ts);
    assert.equal(t.windows.coverage(t.windows.resource('api-gateway'), 'alice').covered, true);
    // An operator adds a resource Bob approves and restarts: the schedule version doesn't change.
    const engine: Resource = { id: 'backend-deploy', name: 'backend deploys', owners: ['alice', 'bob'], approvers: ['bob'], require: 'any', max_duration_minutes: 120 };
    const wider = new Windows(t.core, [...RESOURCES, engine]);
    assert.equal(wider.coverage(engine, 'alice').covered, false, 'Bob never saw it on a card');
    assert.equal(wider.coverage(wider.resource('api-gateway'), 'alice').covered, true, 'what his card listed still counts');
    const r = wider.queue(t.agents.scout, { resource: 'backend-deploy', plan: 'deploy', rollback: 'revert', verify: 'curl' });
    assert.match(r.next, /bob's standing approval is missing: their card was just posted in #ops/);
    await t.settle();
    const extra = t.slack.posts.at(-1)!;
    assert.equal(t.slack.posts.length, 2, 'a second card, only for what is new');
    assert.equal(extra.text, `:calendar: <@${SLACK.bob}> Nightly maintenance also needs your OK for backend deploys (Alice's and Bob's agents).`);
    assert.doesNotMatch(extra.text, /API gateway|Main DB/, 'not what his first card already listed');
    await t.bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(extra, 'sb_std_approve'), user: SLACK.bob, channel: SLACK.ops, messageTs: extra.ts });
    assert.equal(wider.coverage(engine, 'alice').covered, true);
    await t.settle();
    assert.equal(t.slack.updates.at(-1)!.text, ':calendar: Nightly maintenance 21:00–23:00 UTC, also for backend deploys. Approved by Bob.');
    wider.queue(t.agents.builder, { resource: 'backend-deploy', plan: 'deploy', rollback: 'revert', verify: 'curl' });
    await t.settle();
    assert.equal(t.slack.posts.length, 2, 'nothing new to approve, nothing posted');
  });

  test('a standing card is one line however many resources it covers; a supplementary one names them inline, clipped with "and N more" (P2)', async () => {
    const t = setup();
    t.windows.askStanding(['bob']);
    await t.settle();
    const many: Resource[] = Array.from({ length: 7 }, (_, i) => ({ id: `extra-${i}`, name: `Control-plane NAT, network and security groups, region ${i}`, owners: ['alice'], approvers: ['bob'], require: 'any' as const, max_duration_minutes: 60 }));
    const wider = new Windows(t.core, [...RESOURCES, ...many]);
    wider.queue(t.agents.scout, { resource: 'extra-0', plan: 'p', rollback: 'r', verify: 'v' });
    await t.settle();
    const extra = t.slack.posts.at(-1)!;
    assert.equal(extra.text, `:calendar: <@${SLACK.bob}> Nightly maintenance also needs your OK for Control-plane NAT, network and security groups, region 0 and 6 more (Alice's agents).`);
    assert.ok(!extra.text.includes('\n') && extra.text.length <= 250, `${extra.text.length} chars`);
    assert.equal(t.core.db.prepare('SELECT json_array_length(covers) AS n FROM standing_cards ORDER BY id DESC LIMIT 1').get()!['n'], 7, 'the card still approves all seven');
  });

  test('a card counts a pair only under the approvers and mode it listed: a joint approval never becomes a solo one; narrowing still works', async () => {
    const t = setup();
    t.windows.askStanding(['alice', 'bob']);
    await t.settle();
    await t.standing(1, 'alice', SLACK.alice);
    await t.standing(1, 'bob', SLACK.bob);
    assert.equal(t.windows.coverage(t.windows.resource('main-db'), 'alice').covered, true, 'require all: both approved');
    const changed = (patch: Partial<Resource>) => new Windows(t.core, RESOURCES.map((r) => (r.id === 'main-db' ? { ...r, ...patch } : r)));
    // Alice's card said "once Bob approves too": a config that drops that never makes her approval enough alone.
    const patches: Array<[string, Partial<Resource>]> = [['Alice alone', { approvers: ['alice'], require: 'any' }], ['either of them', { require: 'any' }]];
    for (const [name, patch] of patches) {
      const w = changed(patch);
      assert.equal(w.coverage(w.resource('main-db'), 'alice').covered, false, name);
      assert.equal(w.coverage(w.resource('main-db'), 'bob').covered, false, name);
    }
    const solo = changed({ approvers: ['alice'], require: 'any' });
    const posts = t.slack.posts.length;
    solo.queue(t.agents.scout, { resource: 'main-db', plan: 'migrate', rollback: 'restore the snapshot', verify: 'select 1' });
    await t.settle();
    const card = t.slack.posts.at(-1)!;
    assert.equal(t.slack.posts.length, posts + 1, 'a new card for what the config now asks of Alice');
    assert.equal(card.text, `:calendar: <@${SLACK.alice}> Nightly maintenance also needs your OK for Main DB (Alice's and Bob's agents).`);
    assert.doesNotMatch(card.text, /once Bob approves too|staging box/, 'just the changed pairs, now Alice\'s alone');
    await t.bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(card, 'sb_std_approve'), user: SLACK.alice, channel: SLACK.ops, messageTs: card.ts });
    assert.equal(solo.coverage(solo.resource('main-db'), 'alice').covered, true, 'once she approved that');
    // Narrowing: with main-db gone, the other pairs on both cards still count, no new card.
    const narrower = new Windows(t.core, RESOURCES.filter((r) => r.id !== 'main-db'));
    assert.equal(narrower.coverage(narrower.resource('api-gateway'), 'alice').covered, true);
    assert.equal(narrower.coverage(narrower.resource('alice-box'), 'alice').covered, true);
  });

  test('with a temporary override reverted, Alice\'s approval covers nothing the restored config gives Bob', async () => {
    const t = setup();
    const override = new Windows(t.core, RESOURCES.map((r) => ({ ...r, approvers: ['alice'], require: 'any' as const })));
    override.askStanding(['alice']);
    await t.settle();
    await t.standing(1, 'alice', SLACK.alice, 'approve', t.slack.posts[0]!.ts);
    for (const r of RESOURCES) for (const p of r.owners) assert.equal(override.coverage(override.resource(r.id), p).covered, true, `override: ${r.id} for ${p}`);
    const restored = new Windows(t.core, RESOURCES);
    for (const r of RESOURCES) {
      for (const p of r.owners) {
        const { approvers, covered } = restored.coverage(r, p);
        if (approvers.includes('bob')) assert.equal(covered, false, `restored: ${r.id} for ${p}'s agents needs Bob`);
      }
    }
    assert.equal(restored.coverage(restored.resource('alice-box'), 'alice').covered, true, 'still Alice\'s to approve, and on her card');
  });

  test('changing the time bumps the version, voids standing approvals and old cards, and is announced once in #ops', async () => {
    const { windows, slack, settle, standing, core } = setup();
    const gateway = windows.resource('api-gateway');
    windows.askStanding(['bob']);
    await settle();
    const card = slack.posts[0]!;
    await standing(1, 'bob', SLACK.bob, 'approve', card.ts);
    assert.equal(windows.coverage(gateway, 'alice').covered, true);

    assert.throws(() => windows.setSchedule({ start: '25:00', duration_minutes: 60 }, 'ops'), (e: unknown) => e instanceof SwitchboardError && e.code === 'invalid');
    assert.throws(() => windows.setSchedule({ start: '22:00', duration_minutes: 721 }, 'ops'), (e: unknown) => e instanceof SwitchboardError && e.code === 'invalid');
    assert.equal(windows.setSchedule({ start: '21:00', duration_minutes: 120 }, 'ops').changed, false, 'the same time is no change');
    const r = windows.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops');
    assert.deepEqual([r.changed, r.schedule.version, r.schedule.start], [true, 2, '22:00']);
    assert.equal(windows.coverage(gateway, 'alice').covered, false, 'void: a standing approval is for one version');
    await settle();
    const notices = slack.posts.filter((p) => !p.threadTs && p !== card);
    assert.equal(notices.length, 1, 'one announcement');
    assert.equal(notices[0]!.text, 'Nightly maintenance is now 22:00–00:00 UTC (was 21:00–23:00); the next slot starts Oct 14 22:00 UTC. Standing approvals for the old time are void; each approver gets a new card when a queued change needs one.');
    assert.equal((notices[0]!.blocks ?? []).at(-1)?.['type'], 'context', 'a system notice with the footer');
    assert.equal(slack.updates.at(-1)!.text, ':calendar: Nightly maintenance 21:00–23:00 UTC. Void: the slot moved to 22:00–00:00 UTC.');
    assert.deepEqual(slack.updates.at(-1)!.blocks!.filter((b) => b['type'] === 'actions'), [], 'the old card has no buttons left');
    await standing(1, 'bob', SLACK.bob, 'approve', card.ts);
    assert.match(slack.ephemerals.at(-1)!.text, /older maintenance time/);
    assert.equal(windows.coverage(gateway, 'alice').covered, false);
    const oldCard = (core.db.prepare("SELECT id FROM standing_cards WHERE version = 1 AND approver = 'bob'").get() as { id: number }).id;
    assert.throws(() => core.db.prepare("INSERT INTO standing_approvals (card_id, approver, slack_user_id, decision, decided_at) VALUES (?, 'bob', ?, 'approve', 'x')").run(oldCard, SLACK.bob), /current schedule/);
    assert.throws(() => core.db.prepare("UPDATE schedules SET start_hhmm = '23:00'").run(), /append-only/);

    assert.deepEqual(windows.askStanding(['bob']), [{ approver: 'bob', card: 'posted' }], 'a new card for the new version');
  });
});

describe('queued changes (P5)', () => {
  const change = { plan: 'deploy frontend 1a2b3c', rollback: 'redeploy the previous image', verify: 'curl /health' };
  const approve = async (t: ReturnType<typeof setup>, approver: 'alice' | 'bob') => {
    t.windows.askStanding([approver]);
    await t.standing(t.windows.schedule().version, approver, SLACK[approver]);
  };

  test('request_window without urgent queues a change for the next slot: no window, no Slack post, no ops wake', async () => {
    const t = setup();
    await approve(t, 'bob');
    await t.settle();
    const before = { posts: t.slack.posts.length, updates: t.slack.updates.length, events: t.count('events') };
    const r = t.windows.queue(t.agents.scout, { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, ...change });
    await t.settle();
    assert.match(r.change, /^c_[0-9a-f]{12}$/);
    assert.deepEqual(r.slot, { start: '2026-10-14T21:00:00.000Z', end: '2026-10-14T23:00:00.000Z' });
    assert.equal(r.covered, true);
    assert.match(r.next, /At the slot, call window_status\(resource: "api-gateway"\).*may_proceed is true.*report_window\(id: "c_/);
    assert.match(r.note!, /start and duration_minutes are ignored/, 'old clients still work, and are told');
    assert.equal(t.count('windows'), 0);
    assert.deepEqual({ posts: t.slack.posts.length, updates: t.slack.updates.length, events: t.count('events') }, before, 'nothing in Slack, no thread, nothing wakes the ops agent');
    assert.equal(t.core.unread('ops').unread, 0);
  });

  test('the first change that needs an approver posts that approver\'s card, once per version; later changes post nothing', async () => {
    const t = setup();
    const first = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    assert.equal(first.covered, false);
    assert.match(first.next, /bob's standing approval is missing: their card was just posted in #ops/);
    assert.equal(first.note, undefined, 'no start or duration given, nothing ignored');
    await t.settle();
    assert.equal(t.slack.posts.length, 1);
    assert.match(t.slack.posts[0]!.text, new RegExp(`^:calendar: <@${SLACK.bob}> Nightly maintenance 21:00–23:00 UTC for 2 shared resources .*Approve once\\?$`));
    const again = t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
    assert.match(again.next, /bob hasn't approved the slot yet: their card is in #ops/);
    t.windows.queue(t.agents.helper, { resource: 'api-gateway', ...change }); // Bob's agents: approvers [bob] too
    await t.settle();
    assert.equal(t.slack.posts.length, 1, 'later changes in that version post nothing');
    t.windows.queue(t.agents.scout, { resource: 'alice-box', ...change });
    await t.settle();
    assert.equal(t.slack.posts.length, 2, 'a change that needs another approver posts their card');
    assert.equal(t.slack.posts[1]!.text, `:calendar: <@${SLACK.alice}> Nightly maintenance 21:00–23:00 UTC for 2 shared resources (Alice's and Bob's agents). Approve once?`);

    // A new time voids the approvals; the queued changes ask again, once per approver.
    t.windows.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops');
    await t.settle();
    const cards = t.slack.posts.filter((p) => /Approve once\?/.test(p.text));
    assert.equal(cards.length, 4, 'one new card each for Bob and Alice');
    assert.match(cards.at(-1)!.text + cards.at(-2)!.text, /22:00–00:00 UTC/);
  });

  test('window_status says go only inside an approved slot, to an agent with a queued change on a covered resource', async () => {
    const t = setup();
    await approve(t, 'bob');
    const mine = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    const db = t.windows.queue(t.agents.scout, { resource: 'main-db', ...change }); // require all: Alice hasn't approved
    const status = (agent = t.agents.scout, resource = 'api-gateway') => t.windows.status(agent, { resource });

    const early = status();
    assert.equal(early.may_proceed, false, 'before the slot');
    assert.equal(early.change, mine.change);
    assert.match(early.reason, /queued for the slot at Oct 14 21:00 UTC/);
    t.clock.advance(9 * 60 + 30); // 21:30
    const go = status();
    assert.equal(go.may_proceed, true, 'inside the approved slot');
    assert.deepEqual([go.change, go.slot.start, go.slot.end, go.slot.active, go.minutes_left], [mine.change, '2026-10-14T21:00:00.000Z', '2026-10-14T23:00:00.000Z', true, 90]);
    assert.equal(t.windows.status(t.agents.scout, { id: mine.change }).may_proceed, true, 'by change id too');
    const uncovered = status(t.agents.scout, 'main-db');
    assert.equal(uncovered.may_proceed, false, 'an uncovered resource');
    assert.match(uncovered.reason, /doesn't cover main-db for alice's agents: alice's standing approval is missing/);
    assert.equal(t.windows.status(t.agents.scout, { id: db.change }).may_proceed, false);
    const none = status(t.agents.builder);
    assert.equal(none.may_proceed, false, 'an agent with no queued change');
    assert.match(none.reason, /no queued change on api-gateway in it/);
    assert.equal(status(t.agents.helper).may_proceed, false, 'nor the other principal\'s agent');
    t.clock.advance(90); // 23:00
    assert.equal(status().may_proceed, false, 'after the slot');
    assert.equal(t.windows.status(t.agents.scout, { id: mine.change }).may_proceed, false);
    assert.equal(errCode(() => t.windows.status(t.agents.helper, { id: t.windows.queue(t.agents.scout, { resource: 'alice-box', ...change }).change })), 'not_found', 'another principal\'s change on a resource it doesn\'t own');
  });

  test('losing coverage mid-slot, by a revoke or a new time, steers each agent with a queued change in it to stop and report', async () => {
    const t = setup();
    await approve(t, 'bob');
    const a = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    const b = t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
    t.windows.queue(t.agents.scout, { resource: 'alice-box', ...change }); // never covered: Alice hasn't approved
    t.clock.t = Date.parse('2026-10-14T21:10:00Z');
    assert.equal(t.windows.status(t.agents.scout, { resource: 'api-gateway' }).may_proceed, true);
    for (const x of [t.s.scout, t.s.builder, t.s.helper]) x.readInbox();
    await t.settle();
    const posts = t.slack.posts.length;

    await t.standing(1, 'bob', SLACK.bob, 'revoke');
    const told = (session: typeof t.s.scout) => session.readInbox().map((i) => [i.inbox_priority, i.type, i.body['change'], String(i.body['text'])]);
    const stop = (id: string) => `The maintenance slot no longer covers api-gateway for your change ${id}: stop, leave prod in a known state, and report_window(id: "${id}") with what you did.`;
    assert.deepEqual(told(t.s.scout), [['steer', 'slot_lost', a.change, stop(a.change)]]);
    assert.deepEqual(told(t.s.builder), [['steer', 'slot_lost', b.change, stop(b.change)]]);
    assert.deepEqual(told(t.s.helper), [], 'only agents with a change the slot covered');

    await t.standing(1, 'bob', SLACK.bob, 'approve');
    assert.equal(t.windows.status(t.agents.scout, { resource: 'api-gateway' }).may_proceed, true, 'covered again');
    t.windows.setSchedule({ start: '21:30', duration_minutes: 120 }, 'ops');
    assert.deepEqual(told(t.s.scout).map((x) => x[1]), ['slot_lost'], 'a new time voids the approval: the same steer');
    assert.deepEqual(told(t.s.builder).map((x) => x[1]), ['slot_lost']);
    await t.settle();
    assert.ok(!t.slack.posts.slice(posts).some((p) => p.text.includes('no longer covers')), 'agents only, never Slack');
  });

  test('reply routing: an urgent window\'s decision and clock reach the session that requested it, a lost slot the session that queued the change', async () => {
    const t = setup();
    const as = (n: number, extra: ClientHints = { poll: true }) => t.core.forAgent(t.agents.scout, hint(n, { repo: `repo-${n}` }, extra));
    const [one, two] = [as(1), as(2)];
    t.clock.advance(1);
    as(2, {}); // a request: two is the most recently active, so only reply routing sends anything to one
    const w = t.windows.request(t.agents.scout, { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v' }, one.session!.id);
    await t.press(w.window, SLACK.bob);
    t.clock.t = Date.parse('2026-10-14T14:00:00Z');
    as(1); as(2);
    t.windows.tick();
    assert.deepEqual(one.readInbox().map((i) => [i.type, i.body['state']]), [['window_decision', 'approved'], ['window_state', 'active']]);
    assert.deepEqual(two.readInbox(), []);

    await approve(t, 'bob');
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }, one.session!.id);
    t.clock.t = Date.parse('2026-10-14T21:10:00Z');
    as(1); t.clock.advance(1); as(2);
    await t.standing(1, 'bob', SLACK.bob, 'revoke');
    assert.deepEqual(one.readInbox().map((i) => [i.type, i.body['change']]), [['slot_lost', c.change]]);
    assert.deepEqual(two.readInbox(), []);
  });

  test('a resource that left config, or a principal no longer among its owners, loses the slot\'s cover by change id too', async () => {
    const shared: Resource = { id: 'shared-box', name: 'Shared box', owners: ['alice', 'bob'], approvers: ['alice'], require: 'any', max_duration_minutes: 120 };
    const t = setup();
    const before = new Windows(t.core, [...RESOURCES, shared]);
    const c = before.queue(t.agents.helper, { resource: 'shared-box', ...change }); // Alice's card is posted
    await t.settle();
    await t.standing(1, 'alice', SLACK.alice);
    t.clock.t = Date.parse('2026-10-14T21:10:00Z');
    assert.equal(before.status(t.agents.helper, { id: c.change }).may_proceed, true);
    const restarts: Array<[string, Resource[], RegExp]> = [
      ['Bob no longer owns it', [...RESOURCES, { ...shared, owners: ['alice'] }], /bob no longer owns shared-box/],
      ['it left config', RESOURCES, /shared-box is no longer in the config/],
    ];
    for (const [name, config, why] of restarts) {
      const w = new Windows(t.core, config);
      const st = w.status(t.agents.helper, { id: c.change });
      assert.equal(st.may_proceed, false, name);
      assert.match(st.reason, why, name);
      assert.equal(w.coverage(w.resourceOf({ resource_id: 'shared-box' }), 'bob').covered, false, name);
    }
  });

  test('report_window takes a change id, only from its principal, once the slot has started, and posts nothing', async () => {
    const t = setup();
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    await t.settle();
    const posts = t.slack.posts.length;
    assert.equal(errCode(() => t.windows.report(t.agents.scout, { id: c.change, outcome: 'done', evidence: 'x' })), 'conflict', 'before its slot');
    t.clock.advance(9 * 60 + 10);
    assert.equal(errCode(() => t.windows.report(t.agents.helper, { id: c.change, outcome: 'done', evidence: 'x' })), 'forbidden');
    assert.deepEqual(t.windows.report(t.agents.builder, { id: c.change, outcome: 'rolled_back', evidence: 'health 503; redeployed 9f8e' }), { change: c.change, state: 'rolled_back' });
    assert.equal(errCode(() => t.windows.report(t.agents.scout, { id: c.change, outcome: 'done', evidence: 'x' })), 'conflict', 'already reported');
    assert.equal(t.windows.status(t.agents.scout, { id: c.change }).state, 'rolled_back');
    await t.settle();
    assert.equal(t.slack.posts.length, posts);
  });

  test('a new time still moves the slot when queued changes need a pair no approver can approve any more: a resource left config, or the principal no longer owns it', () => {
    const variants: Array<[string, Resource[]]> = [
      ['resource left config', RESOURCES.filter((r) => r.id !== 'alice-box')],
      ['principal dropped from owners', RESOURCES.map((r) => (r.id === 'alice-box' ? { ...r, owners: ['bob'] } : r))],
    ];
    for (const [name, config] of variants) {
      const t = setup();
      t.windows.queue(t.agents.scout, { resource: 'alice-box', ...change });
      t.windows.queue(t.agents.builder, { resource: 'alice-box', ...change });
      const restarted = new Windows(t.core, config);
      assert.equal(restarted.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops').schedule.version, 2, name);
      assert.equal(t.count('standing_cards WHERE version = 2'), 0, `${name}: no card for what no one can approve`);
    }
  });

  test('a new time mid-slot ends the slot for changes in progress: they keep the slot they ran in, can report, and are summarized and tagged', async () => {
    for (const start of ['21:30', '08:00']) { // later the same night; earlier, which would have pushed them to tomorrow
      const t = setup();
      await approve(t, 'bob');
      const a = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
      t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
      t.clock.t = Date.parse('2026-10-14T21:10:00Z');
      assert.equal(t.windows.status(t.agents.scout, { resource: 'api-gateway' }).may_proceed, true);
      t.s.scout.readInbox();
      t.windows.setSchedule({ start, duration_minutes: 120 }, 'ops');
      const st = t.windows.status(t.agents.scout, { id: a.change });
      assert.ok('slot' in st);
      assert.deepEqual([st.slot, st.may_proceed], [{ start: '2026-10-14T21:00:00.000Z', end: '2026-10-14T21:10:00.000Z', active: false }, false], `${start}: it ran in tonight's slot, which ended now`);
      assert.match(String(t.s.scout.readInbox()[0]!.body['text']), /stop, leave prod in a known state, and report_window/, start);
      assert.deepEqual(t.windows.report(t.agents.scout, { id: a.change, outcome: 'partial', evidence: 'stopped halfway; health 200' }), { change: a.change, state: 'partial' }, `${start}: the report it was told to send is taken`);
      t.clock.t = Date.parse('2026-10-14T21:40:00Z');
      assert.deepEqual(t.windows.tick().map((e) => e.body['text']), [
        '@alice, check prod is in a known state. Maintenance Oct 14 21:00–21:10 UTC: 2 changes. API gateway: partial (alice/scout). API gateway: not reported (alice/builder).',
      ], `${start}: tonight is summarized, and the change nobody reported is tagged`);
    }
  });

  test('a new time mid-slot moves a change the slot didn\'t cover to tonight\'s new slot: no early end, no summary, no tag', async () => {
    const t = setup();
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Bob hasn't approved
    t.clock.t = Date.parse('2026-10-14T21:15:00Z');
    t.windows.setSchedule({ start: '23:00', duration_minutes: 120 }, 'ops');
    const st = t.windows.status(t.agents.scout, { id: c.change });
    assert.ok('slot' in st);
    assert.deepEqual(st.slot, { start: '2026-10-14T23:00:00.000Z', end: '2026-10-15T01:00:00.000Z', active: false }, 'it never ran, so it waits for tonight\'s new slot');
    assert.equal(t.core.unread('agent:alice/scout').steer, 0, 'nothing to stop');
    await t.settle();
    assert.match(t.slack.textIn(SLACK.ops), /Nightly maintenance is now 23:00–01:00 UTC \(was 21:00–23:00\); the next slot starts Oct 14 23:00 UTC\./, 'the notice names the next slot\'s date');
    t.clock.t = Date.parse('2026-10-14T21:45:00Z');
    assert.deepEqual(t.windows.tick(), [], 'no summary and no tag at 21:45');
  });

  test('moving the slot earlier moves a change whose slot under the new time is already over to the next slot, instead of paging', async () => {
    const t = setup();
    await approve(t, 'bob');
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Oct 14 21:00–23:00
    t.windows.setSchedule({ start: '08:00', duration_minutes: 60 }, 'ops'); // at 12:00, today's 08:00 slot is over
    const moved = t.windows.status(t.agents.scout, { id: c.change });
    assert.ok('slot' in moved);
    assert.deepEqual(moved.slot, { start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z', active: false });
    t.clock.advance(60); // 13:00: past today's 08:00 slot end + grace
    assert.deepEqual(t.windows.tick(), [], 'no summary and no page: it never had a slot');
    await t.settle();
    await t.standing(2, 'bob', SLACK.bob); // the new time voided the approval; its new card is posted
    t.clock.t = Date.parse('2026-10-15T08:10:00Z');
    assert.equal(t.windows.status(t.agents.scout, { resource: 'api-gateway' }).may_proceed, true, 'it runs in tomorrow\'s slot');
    t.windows.report(t.agents.scout, { id: c.change, outcome: 'done', evidence: 'ok' });
    assert.throws(() => t.core.db.prepare("UPDATE changes SET slot_day = '2026-10-20'").run(), /only while it is queued/);
  });

  test('moving the time away and back puts a change that hasn\'t started back in tonight\'s slot, not a day late', () => {
    const t = setup();
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Oct 14 21:00–23:00
    const slot = () => { const st = t.windows.status(t.agents.scout, { id: c.change }); assert.ok('slot' in st); return st.slot.start; };
    t.windows.setSchedule({ start: '08:00', duration_minutes: 120 }, 'ops'); // at 12:00: tomorrow 08:00
    assert.equal(slot(), '2026-10-15T08:00:00.000Z');
    t.windows.setSchedule({ start: '21:00', duration_minutes: 120 }, 'ops');
    assert.equal(slot(), '2026-10-14T21:00:00.000Z', 'tonight again, the next slot');
  });

  test('a summary already due shows the slot times that actually ran, after a later move of the time', async () => {
    const t = setup();
    const done = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    t.windows.queue(t.agents.builder, { resource: 'alice-box', ...change });
    t.clock.t = Date.parse('2026-10-14T21:30:00Z');
    t.windows.report(t.agents.scout, { id: done.change, outcome: 'done', evidence: 'ok' });
    t.clock.t = Date.parse('2026-10-14T23:10:00Z'); // the slot is over; its summary is due at 23:30
    t.windows.setSchedule({ start: '03:00', duration_minutes: 60 }, 'ops');
    assert.deepEqual(t.windows.tick(), [], 'still within the grace after the slot that ran');
    t.clock.t = Date.parse('2026-10-14T23:30:00Z');
    const [summary, ...more] = t.windows.tick();
    assert.deepEqual(more, []);
    assert.match(String(summary!.body['text']), /^@alice, check prod is in a known state\. Maintenance Oct 14 21:00–23:00 UTC: 2 changes\. API gateway: done \(alice\/scout\)\. Alice's staging box: not reported/);
  });

  test('a day whose slot already ran never takes a second one, even before its summary', () => {
    const t = setup();
    t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Oct 14 21:00–23:00, never reported
    t.clock.t = Date.parse('2026-10-14T23:10:00Z'); // over; its summary is due at 23:30
    t.windows.setSchedule({ start: '23:20', duration_minutes: 120 }, 'ops'); // Oct 14's slot would be 23:20–01:20
    assert.equal(t.windows.nextSlot().day, '2026-10-15', 'Oct 14 had its slot');
    const c = t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
    assert.deepEqual(c.slot, { start: '2026-10-15T23:20:00.000Z', end: '2026-10-16T01:20:00.000Z' });
    t.clock.t = Date.parse('2026-10-14T23:30:00Z');
    assert.deepEqual(t.windows.tick().map((e) => String(e.body['text']).replace(/^@\w+, check prod is in a known state\. /, '').split('. ')[0]), ['Maintenance Oct 14 21:00–23:00 UTC: 1 change'], 'only the change that ran then');
  });

  test('a day where a change already ran and reported never takes a slot that starts at another time', async () => {
    const t = setup();
    await approve(t, 'bob');
    const done = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Oct 14 21:00–23:00
    t.clock.t = Date.parse('2026-10-14T21:40:00Z');
    t.windows.report(t.agents.scout, { id: done.change, outcome: 'done', evidence: 'ok' }); // keeps slot_end 23:00
    t.clock.t = Date.parse('2026-10-14T21:45:00Z');
    t.windows.setSchedule({ start: '22:30', duration_minutes: 90 }, 'ops'); // Oct 14's slot would be 22:30–00:00
    assert.equal(t.windows.nextSlot().day, '2026-10-15', 'Oct 14 had its slot, at 21:00');
    const c = t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
    assert.deepEqual(c.slot, { start: '2026-10-15T22:30:00.000Z', end: '2026-10-16T00:00:00.000Z' });
    t.clock.t = Date.parse('2026-10-14T23:30:00Z');
    assert.deepEqual(t.windows.tick().map((e) => String(e.body['text']).replace(/^@\w+, check prod is in a known state\. /, '').split('. ')[0]), ['Maintenance Oct 14 21:00–23:00 UTC: 1 change'], 'only what ran in it');
  });

  test('a day already summarized never takes new changes, even when a new time makes its slot current again', () => {
    const t = setup();
    t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }); // Oct 14 21:00–23:00
    t.clock.t = Date.parse('2026-10-14T23:30:00Z');
    assert.equal(t.windows.tick().length, 1, 'Oct 14 is summarized');
    t.clock.t = Date.parse('2026-10-14T23:45:00Z');
    t.windows.setSchedule({ start: '23:00', duration_minutes: 120 }, 'ops'); // Oct 14's slot would be 23:00–01:00, on now
    assert.equal(t.windows.nextSlot().day, '2026-10-15', 'not the summarized day');
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    assert.deepEqual(c.slot, { start: '2026-10-15T23:00:00.000Z', end: '2026-10-16T01:00:00.000Z' });
    t.clock.t = Date.parse('2026-10-16T01:30:00Z');
    assert.deepEqual(t.windows.tick().map((e) => String(e.body['text']).replace(/^@\w+, check prod is in a known state\. /, '').split('. ')[0]), ['Maintenance Oct 15 23:00–01:00 UTC: 1 change'], 'and it is summarized');
  });

  test('withdrawn: only the change\'s own agent, only while queued and before its slot, a short reason; it never goes ahead, is never not_reported or tagged, the summary leaves it out, and nothing reaches Slack', async () => {
    const t = setup();
    await approve(t, 'bob');
    const gone = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    const kept = t.windows.queue(t.agents.scout, { resource: 'main-db', ...change });
    const late = t.windows.queue(t.agents.builder, { resource: 'api-gateway', ...change });
    await t.settle();
    const before = { posts: t.slack.posts.length, updates: t.slack.updates.length };
    const withdraw = (agent: keyof typeof t.agents, id: string, evidence = 'Bob asked: he is mid-test on the gateway') =>
      errCode(() => t.windows.report(t.agents[agent], { id, outcome: 'withdrawn', evidence }));
    assert.equal(withdraw('builder', gone.change), 'forbidden', 'another agent of the same principal');
    assert.equal(withdraw('helper', gone.change), 'forbidden', 'the other principal\'s agent');
    assert.equal(withdraw('scout', gone.change, 'x'.repeat(301)), 'invalid', 'a short reason');
    const r = t.windows.report(t.agents.scout, { id: gone.change, outcome: 'withdrawn', evidence: 'Bob asked: he is mid-test on the gateway' });
    assert.equal(r.state, 'withdrawn');
    assert.match('note' in r ? String(r.note) : '', /won't run/);
    assert.equal(withdraw('scout', gone.change), 'conflict', 'already withdrawn');
    assert.equal(t.windows.status(t.agents.scout, { id: gone.change }).state, 'withdrawn');

    t.clock.advance(9 * 60 + 10); // 21:10, in the slot
    assert.equal(withdraw('builder', late.change), 'conflict', 'its slot has started');
    assert.equal(t.windows.status(t.agents.scout, { id: gone.change }).may_proceed, false);
    assert.match(t.windows.status(t.agents.scout, { id: gone.change }).reason, /withdrawn/);
    const res = t.windows.status(t.agents.scout, { resource: 'api-gateway' });
    assert.deepEqual([res.may_proceed, res.change], [false, null], 'a withdrawn change never counts toward may_proceed');
    t.windows.report(t.agents.builder, { id: late.change, outcome: 'done', evidence: 'ok' });
    t.clock.advance(140); // 23:30: the summary
    const [summary] = t.windows.tick();
    assert.equal(summary!.body['text'], '@alice, check prod is in a known state. Maintenance Oct 14 21:00–23:00 UTC: 2 changes. Main DB: not reported (alice/scout). API gateway: done (alice/builder).',
      'the withdrawn change is left out; the tag is for the change that wasn\'t reported');
    assert.equal(t.windows.status(t.agents.scout, { id: gone.change }).state, 'withdrawn', 'never not_reported');
    assert.equal(t.windows.status(t.agents.scout, { id: kept.change }).state, 'not_reported');
    await t.settle();
    assert.equal(t.slack.posts.length, before.posts + 1, 'only the summary');
    assert.equal(t.slack.updates.length, before.updates);

    // A slot whose only change was withdrawn has no summary at all, and takes no slot away from a later change.
    const alone = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    t.windows.report(t.agents.scout, { id: alone.change, outcome: 'withdrawn', evidence: 'not needed' });
    t.clock.advance(24 * 60);
    assert.deepEqual(t.windows.tick(), [], 'no summary for a slot with nothing left in it');
    assert.equal(t.windows.maintenance().changes.length, 0, 'gone from list_maintenance once its slot is over');
    assert.equal(t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change }).slot.start, '2026-10-16T21:00:00.000Z');
  });

  test('a withdrawn change\'s day still takes a slot moved onto it (it never ran)', () => {
    const t = setup();
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    t.windows.report(t.agents.scout, { id: c.change, outcome: 'withdrawn', evidence: 'not needed' });
    t.clock.advance(10 * 60 + 30); // 22:30: tonight's 21:00 slot is "over" for a queued change, but this one never ran
    t.windows.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops');
    assert.equal(t.windows.nextSlot().day, '2026-10-14', 'the 22:00 slot runs tonight');
    assert.equal(t.windows.nextSlot().active, true);
  });

  test('withdrawn is only for a queued change, and the schema refuses a withdrawal of one that isn\'t queued', () => {
    const t = setup();
    const w = t.ask('api-gateway', 30, '2026-10-14T14:00:00Z');
    assert.equal(errCode(() => t.windows.report(t.agents.scout, { id: w.window, outcome: 'withdrawn', evidence: 'not needed' })), 'invalid', 'an urgent window isn\'t a queued change');
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    t.clock.advance(9 * 60 + 10);
    t.windows.report(t.agents.scout, { id: c.change, outcome: 'done', evidence: 'ok' });
    assert.throws(() => t.core.db.prepare("UPDATE changes SET state = 'withdrawn' WHERE id = ?").run(c.change), /only a queued change/);
  });

  test('one Slack summary per slot with changes, after its end plus grace, within the 300-character cap (P2), tagging only for not_reported or failed', async () => {
    const t = setup();
    const a = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    const b = t.windows.queue(t.agents.scout, { resource: 'main-db', ...change });
    t.windows.queue(t.agents.builder, { resource: 'alice-box', ...change });
    await t.settle();
    const cards = t.slack.posts.length;
    t.clock.advance(9 * 60 + 15);
    t.windows.report(t.agents.scout, { id: a.change, outcome: 'done', evidence: 'ok' });
    t.windows.report(t.agents.scout, { id: b.change, outcome: 'rolled_back', evidence: 'reverted' });
    t.clock.advance(105 + 29); // 23:29: end + grace not reached
    assert.deepEqual(t.windows.tick(), []);
    t.clock.advance(1); // 23:30
    const [summary, ...more] = t.windows.tick();
    assert.deepEqual(more, []);
    assert.deepEqual(t.windows.tick(), [], 'once');
    await t.settle();
    const posted = t.slack.posts.slice(cards);
    assert.equal(posted.length, 1);
    const text = String(summary!.body['text']);
    assert.equal(text, '@alice, check prod is in a known state. Maintenance Oct 14 21:00–23:00 UTC: 3 changes. API gateway: done (alice/scout). ' +
      'Main DB: rolled back (alice/scout). Alice\'s staging box: not reported (alice/builder).');
    assert.ok(text.length <= 260, 'its own budget, which leaves the cap room for the mention');
    assert.ok(posted[0]!.text.length <= 300);
    assert.equal(posted[0]!.threadTs, undefined, 'top-level');
    assert.match(posted[0]!.text, new RegExp(`<@${SLACK.alice}>, check prod`), 'the tag becomes a mention');
    assert.equal((posted[0]!.blocks ?? []).at(-1)?.['type'], 'context', 'a system notice with the footer');
    assert.equal(t.windows.status(t.agents.builder, { id: t.core.db.prepare("SELECT id FROM changes WHERE agent_id = 'alice/builder'").get()!['id'] as string }).state, 'not_reported');

    // An empty slot posts nothing; a slot where everything was done tags nobody.
    t.clock.advance(24 * 60);
    assert.deepEqual(t.windows.tick(), [], 'no changes, no summary');
    const c = t.windows.queue(t.agents.scout, { resource: 'api-gateway', ...change });
    t.clock.advance(23 * 60); // in the Oct 16 slot
    t.windows.report(t.agents.scout, { id: c.change, outcome: 'done', evidence: 'ok' });
    t.clock.advance(4 * 60);
    assert.deepEqual(t.windows.tick().map((e) => e.body['text']), ['Maintenance Oct 16 21:00–23:00 UTC: 1 change. API gateway: done (alice/scout).']);
  });

  test('the summary\'s tags come first, so the cap never cuts them, whatever the resource names escape to (P2)', async () => {
    const t = setup();
    t.core.setSlackUser('alice', 'U0123456789'); // real Slack ids are 11 characters
    t.core.setSlackUser('bob', 'U9876543210');
    const rnd: Resource = { id: 'rnd', name: 'R&D&QA&Ops&ML&GPU', owners: ['alice', 'bob'], approvers: ['alice'], require: 'any', max_duration_minutes: 60 };
    const windows = new Windows(t.core, [...RESOURCES, rnd]);
    for (let i = 0; i < 12; i++) windows.queue(i % 2 ? t.agents.helper : t.agents.scout, { resource: 'rnd', ...change });
    t.clock.advance(9 * 60 + 5);
    windows.report(t.agents.helper, { id: t.core.db.prepare("SELECT id FROM changes WHERE agent_id = 'bob/helper' LIMIT 1").get()!['id'] as string, outcome: 'failed', evidence: 'x' });
    t.clock.advance(3 * 60);
    windows.tick();
    await t.settle();
    const summary = t.slack.posts.find((p) => p.text.includes('Maintenance Oct 14'))!;
    assert.ok(summary.text.length <= 300, `${summary.text.length} chars`);
    assert.match(summary.text, /^<@U0123456789> and <@U9876543210>, check prod is in a known state\. Maintenance Oct 14 21:00–23:00 UTC: 12 changes\. R&amp;D&amp;QA/);
  });

  test('a summary with many changes is clipped with "and N more" to fit the 300-character cap with its tags (P2); a failure tags its human too', () => {
    const t = setup();
    for (let i = 0; i < 12; i++) t.windows.queue(i % 2 ? t.agents.helper : t.agents.scout, { resource: 'main-db', ...change });
    t.clock.advance(9 * 60 + 5);
    const first = t.core.db.prepare("SELECT id FROM changes WHERE agent_id = 'bob/helper' LIMIT 1").get()!['id'] as string;
    t.windows.report(t.agents.helper, { id: first, outcome: 'failed', evidence: 'db migration failed' });
    t.clock.advance(3 * 60);
    const text = String(t.windows.tick()[0]!.body['text']);
    assert.ok(text.length <= 260, `${text.length} chars`);
    assert.match(text, /^@alice and @bob, check prod is in a known state\. Maintenance Oct 14 21:00–23:00 UTC: 12 changes\. Main DB: not reported \(alice\/scout\)\. Main DB: failed \(bob\/helper\)\./);
    assert.match(text, /, and \d+ more\.$/);
  });
});

describe('migrations', () => {
  test('a live v7 DB keeps its windows, approvals and audit rows through every later migration; stale ops wake rows are marked read', () => {
    const path = join(tempDir('sb-mig-'), 'switchboard.db');
    const v7 = new DatabaseSync(path);
    v7.exec('PRAGMA foreign_keys = ON;');
    for (const m of MIGRATIONS.slice(0, 7)) v7.exec(m);
    v7.exec('PRAGMA user_version = 7');
    const at = '2026-10-17T20:00:00.000Z';
    v7.exec(`
      INSERT INTO principals VALUES ('alice', 'Alice', '${SLACK.alice}', '${at}'), ('bob', 'Bob', '${SLACK.bob}', '${at}');
      INSERT INTO agents (id, principal_id, name, token_sha256, created_at) VALUES ('alice/claude', 'alice', 'claude', 'abc', '${at}');
      INSERT INTO mutes VALUES ('alice', 'bob', 'all'), ('bob', 'alice', 'all');
      INSERT INTO resources VALUES ('core-api', 'Core API and DB', '["alice","bob"]', '{"approvers":["alice"],"require":"any","max_duration_minutes":120,"note":null}', '${at}');
      INSERT INTO threads (id, kind, visibility, title, slack_channel, slack_ts, slack_synced_seq, created_at) VALUES
        ('w_000000000001', 'window', 'shared', 'Window: Core API', '${SLACK.ops}', '1.1', 3, '${at}'),
        ('w_000000000002', 'window', 'shared', 'Window: Core API', '${SLACK.ops}', '1.2', 1, '${at}');
      INSERT INTO participants (thread_id, actor, joined_at, joined_seq) VALUES ('w_000000000001', 'agent:alice/claude', '${at}', 0), ('w_000000000001', 'principal:alice', '${at}', 0);
      INSERT INTO events VALUES ('w_000000000001', 1, 'agent:alice/claude', 'window_requested', '{"window":"w_000000000001"}', '${at}'),
        ('w_000000000001', 2, 'principal:alice', 'window_decision', '{"decision":"approve"}', '${at}'),
        ('w_000000000001', 3, 'system', 'window_reminder', '{"kind":"starts_soon"}', '${at}'),
        ('w_000000000002', 1, 'agent:alice/claude', 'window_requested', '{"window":"w_000000000002"}', '${at}');
      INSERT INTO inbox (recipient, thread_id, event_seq, priority, kind, created_at) VALUES ('ops', 'w_000000000001', 2, 'deferred', 'approval_decision', '${at}'),
        ('ops', 'w_000000000001', 3, 'deferred', 'window_clock', '${at}'), ('ops', 'w_000000000002', 1, 'deferred', 'window_report', '${at}'),
        ('ops', 'w_000000000002', 1, 'deferred', 'new_window', '${at}'), ('agent:alice/claude', 'w_000000000001', 2, 'steer', 'message', '${at}');
      INSERT INTO windows (id, resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all, state, created_at) VALUES
        ('w_000000000001', 'core-api', 'alice/claude', '2026-10-17T21:00:00.000Z', '2026-10-17T22:00:00.000Z', 'deploy', 'revert', 'curl', '["alice"]', 0, 'proposed', '${at}'),
        ('w_000000000002', 'core-api', 'alice/claude', '2026-10-18T01:00:00.000Z', '2026-10-18T02:00:00.000Z', 'deploy', 'revert', 'curl', '["alice"]', 0, 'proposed', '${at}');
      INSERT INTO approvals (window_id, approver, slack_user_id, decision, decided_at) VALUES ('w_000000000001', 'alice', '${SLACK.alice}', 'approve', '${at}');
      UPDATE windows SET state = 'approved' WHERE id = 'w_000000000001';
      UPDATE windows SET state = 'expired' WHERE id = 'w_000000000002';
      INSERT INTO window_notices VALUES ('w_000000000001', 'starts_soon', '${at}');
      INSERT INTO audit (at, actor, action, detail) VALUES ('${at}', 'agent:alice/claude', 'tool:request_window', '{"resource":"core-api"}'), ('${at}', 'admin', 'add_agent', null);
      INSERT INTO kv VALUES ('engine.active', 'claude-api');
    `);
    const tables = ['principals', 'agents', 'mutes', 'resources', 'threads', 'participants', 'events', 'inbox', 'windows', 'approvals', 'window_notices', 'audit', 'kv', 'relays', 'engine_sessions'];
    const dump = (db: DatabaseSync) => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
    const before = dump(v7);
    v7.close();

    const db = openDb(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    // Ops wake rows of kinds that no longer wake it are marked read, so the deploy doesn't wake it for them.
    const stale = ['approval_decision', 'window_clock', 'window_report'];
    const after = dump(db);
    assert.ok(after['mutes']!.every((m) => typeof m['set_at'] === 'string' && m['set_at'] !== ''), 'P4: migration 11 dates every mute');
    assert.deepEqual({ ...after, mutes: after['mutes']!.map(({ set_at: _, set_mark: __, ...m }) => m) }, { ...before, inbox: before['inbox']!.map((r) => ({ ...(r['recipient'] === 'ops' && stale.includes(String(r['kind'])) ? { ...r, read_at: r['created_at'] } : r), session: null })), // migration 15: untargeted
      windows: before['windows']!.map((r) => ({ ...r, title: titleFrom(String(r['plan'])) })), // P2: migration 10 adds each window's title
      principals: before['principals']!.map((r) => ({ ...r, delegate_agent_id: null })) }, // P4: migration 11, no delegate yet
      'nothing lost or changed, except stale ops wake rows marked read, a title on each window and no delegate on each principal');
    assert.deepEqual(db.prepare("SELECT recipient, kind FROM inbox WHERE read_at IS NULL ORDER BY id").all().map((r) => ({ ...r })),
      [{ recipient: 'ops', kind: 'new_window' }, { recipient: 'agent:alice/claude', kind: 'message' }], 'a wake that still exists, and agents\' mail, stay unread');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM standing_approvals').get() as { n: number }).n, 0);
    const windows = new Windows(new Core(db), [{ id: 'core-api', name: 'Core API and DB', owners: ['alice', 'bob'], approvers: ['alice'], require: 'any', max_duration_minutes: 120 }]);
    assert.equal(windows.schedule().version, 1, 'the schedule is seeded on the first start');
    assert.deepEqual([windows.window('w_000000000001')!.state, windows.window('w_000000000002')!.state], ['approved', 'expired']);
    assert.throws(() => db.prepare("UPDATE windows SET state = 'active' WHERE id = 'w_000000000002'").run(), /illegal window state transition/, 'the old triggers still hold');
    db.close();
  });

  test('migration 10 applies to a DB whose old terms trigger is missing, and leaves the new one in place', () => {
    const path = join(tempDir('sb-mig-'), 'switchboard.db');
    const v9 = new DatabaseSync(path);
    for (const m of MIGRATIONS.slice(0, 9)) v9.exec(m);
    v9.exec('PRAGMA user_version = 9; DROP TRIGGER windows_terms_fixed;');
    v9.close();
    const db = openDb(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'windows_terms_fixed'").get());
    db.close();
  });

  test('the live v9 DB keeps every row through migration 10; each window gets the title titleFrom derives from its plan, fixed like its other terms (P2)', () => {
    const path = join(tempDir('sb-mig-'), 'switchboard.db');
    const v9 = new DatabaseSync(path);
    v9.exec('PRAGMA foreign_keys = ON;');
    for (const m of MIGRATIONS.slice(0, 9)) v9.exec(m);
    v9.exec('PRAGMA user_version = 9');
    const at = '2026-10-18T13:00:00.000Z';
    const plans = [
      'Raise API rate limits to 2x on web-prod-1. Then restart the service and watch errors for 10 min.',
      '  Deploy frontend 1a2b3c (v2.1.3) to prod!  Rollback is the previous image.',
      `${'Bump the API gateway to the patched build with the new reconnect backoff and the fixed heartbeat '.repeat(3)}`,
      'Restart the gateway\nstep 2: curl /health\nstep 3: watch',
      'Is the box idle? If so, reboot it.',
      '...',
      'Tab\tseparated: rotate keys, then verify:',
    ];
    v9.exec(`
      INSERT INTO principals VALUES ('alice', 'Alice', '${SLACK.alice}', '${at}'), ('bob', 'Bob', '${SLACK.bob}', '${at}');
      INSERT INTO agents (id, principal_id, name, token_sha256, created_at) VALUES ('alice/claude', 'alice', 'claude', 'abc', '${at}');
      INSERT INTO resources VALUES ('core-api', 'Core API and DB', '["alice","bob"]', '{"approvers":["alice"],"require":"any","max_duration_minutes":120,"note":null}', '${at}');
      INSERT INTO schedules VALUES (1, '21:00', 120, 'config', '${at}');
      INSERT INTO threads (id, kind, visibility, title, slack_channel, slack_ts, slack_synced_seq, created_at) VALUES ('t_000000000009', 'chat', 'shared', 'Nightly maintenance', '${SLACK.ops}', '2.1', 1, '${at}');
      INSERT INTO standing_cards (version, approver, covers, thread_id, posted_at) VALUES (1, 'alice', '[["core-api","alice","any",["alice"]]]', 't_000000000009', '${at}');
      INSERT INTO standing_approvals (card_id, approver, slack_user_id, decision, decided_at) VALUES (1, 'alice', '${SLACK.alice}', 'approve', '${at}');
      INSERT INTO changes (id, agent_id, resource_id, plan, rollback, verify, slot_day, slot_start, slot_end, state, evidence, reported_at, created_at) VALUES
        ('c_000000000001', 'alice/claude', 'core-api', 'deploy', 'revert', 'curl', '2026-10-17', '2026-10-17T21:00:00.000Z', '2026-10-17T23:00:00.000Z', 'done', 'ok', '${at}', '${at}');
      INSERT INTO slot_summaries VALUES ('2026-10-17', 't_000000000009', '${at}');
      INSERT INTO audit (at, actor, action, detail) VALUES ('${at}', 'agent:alice/claude', 'tool:request_window', '{"resource":"core-api","urgent":true}');
    `);
    plans.forEach((plan, i) => {
      const id = `w_00000000010${i}`;
      v9.prepare("INSERT INTO threads (id, kind, visibility, title, created_at) VALUES (?, 'window', 'shared', 'Window: Core API', ?)").run(id, at);
      v9.prepare(`INSERT INTO windows (id, resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all, state, created_at)
        VALUES (?, 'core-api', 'alice/claude', '2026-10-18T13:23:00.000Z', '2026-10-18T14:08:00.000Z', ?, 'revert', 'curl', '["alice"]', 0, 'proposed', ?)`).run(id, plan, at);
      v9.prepare('INSERT INTO events VALUES (?, 1, \'agent:alice/claude\', \'window_requested\', ?, ?)').run(id, JSON.stringify({ window: id, plan }), at);
    });
    v9.exec(`INSERT INTO approvals (window_id, approver, slack_user_id, decision, decided_at) VALUES ('w_000000000100', 'alice', '${SLACK.alice}', 'approve', '${at}');
      UPDATE windows SET state = 'approved' WHERE id = 'w_000000000100';`);
    const tables = ['principals', 'agents', 'resources', 'threads', 'events', 'windows', 'approvals', 'schedules', 'standing_cards', 'standing_approvals', 'changes', 'slot_summaries', 'audit'];
    const dump = (db: DatabaseSync) => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
    const before = dump(v9);
    v9.close();

    const db = openDb(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    const after = dump(db);
    assert.deepEqual(after, { ...before, windows: before['windows']!.map((r) => ({ ...r, title: titleFrom(String(r['plan'])) })),
      principals: before['principals']!.map((r) => ({ ...r, delegate_agent_id: null })), changes: before['changes']!.map((r) => ({ ...r, session: null })) },
      'nothing lost or changed; each window has a title, no principal a delegate (P4), no change a session (migration 15)');
    assert.deepEqual(after['windows']!.map((r) => r['title']), [
      'Raise API rate limits to 2x on web-prod-1',
      'Deploy frontend 1a2b3c (v2.1.3) to prod',
      `${'Bump the API gateway to the patched build with the new reconnect backoff and the fixed heartbeat'.slice(0, 79)}…`,
      'Restart the gateway',
      'Is the box idle',
      'maintenance',
      'Tab separated: rotate keys, then verify',
    ], 'the SQL in migration 10 and titleFrom agree');
    const windows = new Windows(new Core(db), [{ id: 'core-api', name: 'Core API and DB', owners: ['alice', 'bob'], approvers: ['alice'], require: 'any', max_duration_minutes: 120 }]);
    assert.equal(windows.window('w_000000000100')!.title, 'Raise API rate limits to 2x on web-prod-1');
    assert.equal(windows.window('w_000000000100')!.state, 'approved');
    assert.equal(windows.coverage(windows.resource('core-api'), 'alice').covered, true, 'the standing approval still counts');
    assert.throws(() => db.prepare("UPDATE windows SET title = 'x' WHERE id = 'w_000000000100'").run(), /fixed once requested/);
    assert.throws(() => db.prepare("UPDATE windows SET plan = 'x' WHERE id = 'w_000000000100'").run(), /fixed once requested/, 'the other terms still are');
    db.close();
  });
});

describe('migration 12', () => {
  test('a live v11 DB keeps every change, rowid included, and its triggers; withdrawn becomes a state', () => {
    const path = join(tempDir('sb-mig-'), 'switchboard.db');
    const v11 = new DatabaseSync(path);
    v11.exec('PRAGMA foreign_keys = ON;');
    for (const m of MIGRATIONS.slice(0, 11)) v11.exec(m);
    v11.exec('PRAGMA user_version = 11');
    const at = '2026-10-21T08:00:00.000Z';
    v11.exec(`
      INSERT INTO principals (id, name, slack_user_id, created_at) VALUES ('alice', 'Alice', '${SLACK.alice}', '${at}');
      INSERT INTO agents (id, principal_id, name, token_sha256, created_at) VALUES ('alice/claude', 'alice', 'claude', 'abc', '${at}');
      UPDATE principals SET delegate_agent_id = 'alice/claude' WHERE id = 'alice';
      INSERT INTO resources VALUES ('core-api', 'Core API and DB', '["alice"]', '{"approvers":["alice"],"require":"any","max_duration_minutes":120,"note":null}', '${at}');
      INSERT INTO threads (id, kind, visibility, title, created_at) VALUES ('t_000000000009', 'chat', 'shared', 'Maintenance', '${at}');
      INSERT INTO slot_summaries VALUES ('2026-10-20', 't_000000000009', '${at}');
    `);
    const states = ['done', 'rolled_back', 'failed', 'partial', 'not_reported', 'queued'];
    states.forEach((state, i) => {
      const day = state === 'queued' ? '2026-10-21' : '2026-10-20';
      v11.prepare(`INSERT INTO changes (id, agent_id, resource_id, plan, rollback, verify, slot_day, slot_start, slot_end, state, evidence, reported_at, created_at)
        VALUES (?, 'alice/claude', 'core-api', 'deploy', 'revert', 'curl', ?, ?, ?, ?, ?, ?, '${at}')`).run(`c_00000000000${i}`, day, `${day}T21:00:00.000Z`, `${day}T23:00:00.000Z`, state,
        state === 'queued' ? null : 'ok', state === 'queued' ? null : at);
    });
    v11.exec("DELETE FROM changes WHERE id = 'c_000000000002'; INSERT INTO changes SELECT * FROM (SELECT 'c_00000000000x', agent_id, resource_id, plan, rollback, verify, slot_day, slot_start, slot_end, state, evidence, reported_at, created_at FROM changes LIMIT 1)");
    const dump = (db: DatabaseSync) => db.prepare('SELECT rowid, * FROM changes ORDER BY rowid').all().map((r) => ({ ...r }));
    const before = dump(v11);
    v11.close();
    const db = openDb(path);
    assert.ok((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 12);
    assert.deepEqual(dump(db), before.map((r) => ({ ...r, session: null })), 'every change, with its rowid (ties order by it), and no session (migration 15)');
    assert.equal((db.prepare("SELECT delegate_agent_id FROM principals").get() as { delegate_agent_id: string }).delegate_agent_id, 'alice/claude');
    assert.throws(() => db.prepare("UPDATE changes SET plan = 'x' WHERE id = 'c_000000000000'").run(), /fixed once queued/);
    assert.throws(() => db.prepare("UPDATE changes SET slot_day = '2026-10-22' WHERE id = 'c_000000000000'").run(), /only while it is queued/);
    assert.throws(() => db.prepare("UPDATE changes SET state = 'withdrawn' WHERE id = 'c_000000000000'").run(), /only a queued change/);
    assert.throws(() => db.prepare("UPDATE changes SET state = 'maybe' WHERE id = 'c_000000000005'").run(), /CHECK/);
    db.prepare("UPDATE changes SET state = 'withdrawn' WHERE id = 'c_000000000005'").run();
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'changes_slot'").get());
    db.close();
  });
});

describe('idle agents', () => {
  test('after the threshold the agent\'s human is pinged once in their DM', async () => {
    const { core, s, clock, slack, settle } = setup();
    s.scout.sendMessage('builder', 'are you there?');
    assert.deepEqual(core.pingIdleAgents(30), []);
    clock.advance(31);
    assert.equal(core.pingIdleAgents(30).length, 1);
    assert.deepEqual(core.pingIdleAgents(30), []);
    await settle();
    assert.match(slack.textIn(`D${SLACK.alice}`), new RegExp(`<@${SLACK.alice}>, 1 switchboard message\\(s\\) have waited over 30 min for your agent alice/builder`));
  });
});
