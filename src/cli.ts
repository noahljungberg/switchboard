#!/usr/bin/env node
// `switchboard serve` and `switchboard admin ...`. Admin commands open the same SQLite file the
// service uses (WAL), so a revoke or mute takes effect on the next request. Contract: docs/design/service.md.

import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, loadSecrets } from './config.ts';
import { Memory } from './context.ts';
import { Core, type MuteMode, SwitchboardError } from './core.ts';
import { openDb } from './db.ts';
import { contextDir, dbPath, start } from './main.ts';
import { Windows, span } from './windows.ts';

const USAGE = `usage:
  switchboard serve [--config path]
  switchboard admin [--config path] <command>

admin commands:
  add-principal <id> --name <Name> [--slack <U...>]   add a human (seeds research-lane mutes per config)
  set-slack <principal> <U...>                        set or change a principal's Slack user id
  add-agent <principal> <name>                        add an agent and print its first token
  issue-token <principal/name>                        rotate: print a new token, the old one stops working
  revoke-token <principal/name>                       revoke the agent's token now
  set-mute <principal> <muted-principal> <all|relayed_only|none>
  set-delegate <principal> <agent-id|none>            one of the principal's own agents gets what other principals'
                                                      agents address to that human, instead of the ops agent, which
                                                      otherwise tells them (none: the ops agent again)
  list                                                principals (with their delegate), agents, mutes
  export-thread <thread-id>                           dump a thread as markdown
  memory-revert <sha>                                 revert one ops memory commit
  ask-standing <principal> [--offers-only]            post their nightly-maintenance card now, so they can approve
                                                      before the first queued change (nothing if their cards already
                                                      list all they approve); --offers-only: only the card for what
                                                      another owner already approved (Approve / Revoke), no request
  rerender-cards                                      rewrite every standing card and live urgent-window card in Slack in
                                                      the current format, on its own message (the service does it on its
                                                      next sweep; nothing is posted)
  usage                                               ops agent turns and API-credit spend this month, by engine

config path defaults to $SWITCHBOARD_CONFIG, then ./config.yaml.`;

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { config: { type: 'string' }, name: { type: 'string' }, slack: { type: 'string' }, 'offers-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [mode, command, ...rest] = positionals;
  if (values.help || !mode) { out(USAGE); return mode ? 0 : 2; }
  const config = loadConfig(values.config);

  if (mode === 'serve') {
    const running = await start({ config, secrets: loadSecrets() });
    out(`switchboard: agent MCP at ${running.agentUrl}/mcp${running.ops ? `, ops agent on (ops MCP ${running.ops.url})` : ', ops agent off (no ops: section)'}`);
    watchdog(() => { running.core.db.prepare('SELECT 1').get(); });
    const stop = () => { void running.stop().then(() => process.exit(0)); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return await new Promise<number>(() => {});
  }
  if (mode !== 'admin') { out(USAGE); return 2; }

  const db = openDb(dbPath(config));
  const core = new Core(db, { researchDefault: config.research_lane_default });
  const need = (n: number) => { if (rest.length < n) throw new SwitchboardError('invalid', `${command} needs ${n} argument(s).\n\n${USAGE}`); };
  try {
    switch (command) {
      case 'add-principal': {
        need(1);
        if (!values.name) throw new SwitchboardError('invalid', 'add-principal needs --name.');
        const p = core.addPrincipal(rest[0]!, values.name, values.slack ?? null);
        out(`added principal ${p.id} (${p.name}), research lane default: ${config.research_lane_default}`);
        break;
      }
      case 'set-slack':
        need(2);
        core.setSlackUser(rest[0]!, rest[1]!);
        out(`${rest[0]} is Slack user ${rest[1]}`);
        break;
      case 'add-agent': {
        need(2);
        const a = core.addAgent(rest[0]!, rest[1]!);
        out(`added agent ${a.id}\ntoken (shown once, store it in the agent's env as SWITCHBOARD_TOKEN):\n${core.issueToken(a.id)}`);
        break;
      }
      case 'issue-token':
        need(1);
        out(`new token for ${rest[0]} (shown once; the previous token no longer works):\n${core.issueToken(rest[0]!)}`);
        break;
      case 'revoke-token':
        need(1);
        core.revokeToken(rest[0]!);
        out(`revoked ${rest[0]}'s token`);
        break;
      case 'set-mute': {
        need(3);
        const mode = rest[2] as MuteMode | 'none';
        if (!['all', 'relayed_only', 'none'].includes(mode)) throw new SwitchboardError('invalid', 'mode must be all, relayed_only or none.');
        core.setMute(rest[0]!, rest[1]!, mode);
        out(mode === 'none' ? `${rest[0]} hears from ${rest[1]}'s agents directly` : `${rest[0]} mutes ${rest[1]}'s agents: ${mode}`);
        break;
      }
      case 'set-delegate': {
        need(2);
        const agent = rest[1] === 'none' ? null : rest[1]!;
        core.setDelegate(rest[0]!, agent);
        out(agent ? `${rest[0]}'s delegate is ${agent}: what other principals' agents address to ${rest[0]} goes to its inbox, not to ${rest[0]}`
          : `${rest[0]} has no delegate: what other principals' agents address to ${rest[0]} goes to the ops agent, which tells ${rest[0]} what they need`);
        break;
      }
      case 'list': {
        for (const p of core.principals()) out(`principal ${p.id}  ${p.name}  slack=${p.slack_user_id ?? '-'}  delegate=${p.delegate_agent_id ?? '-'}`);
        for (const a of core.agents()) out(`agent ${a.id}  ${a.revoked_at ? 'REVOKED' : 'active'}  last_seen=${a.last_seen_at ?? '-'}`);
        for (const m of db.prepare('SELECT * FROM mutes ORDER BY principal_id').all() as Array<{ principal_id: string; muted_principal_id: string; mode: string }>) {
          out(`mute ${m.principal_id} ← ${m.muted_principal_id}: ${m.mode}`);
        }
        break;
      }
      case 'export-thread':
        need(1);
        out(core.exportThread(rest[0]!));
        break;
      case 'usage': {
        const month = new Date().toISOString().slice(0, 7);
        const rows = db.prepare(`SELECT json_extract(detail, '$.engine') AS engine, COUNT(*) AS turns, ROUND(SUM(COALESCE(json_extract(detail, '$.cost_usd'), 0)), 2) AS usd
          FROM audit WHERE action = 'turn' AND at LIKE ? GROUP BY engine ORDER BY engine`).all(`${month}%`) as Array<{ engine: string; turns: number; usd: number }>;
        out(`ops agent, ${month} (calendar month; the API credits reset on the plan's billing date):`);
        for (const r of rows) out(`  ${r.engine}: ${r.turns} turns${r.engine === 'claude-api' ? `, $${r.usd} of API credits` : ''}`);
        if (rows.length === 0) out('  no turns yet');
        break;
      }
      case 'ask-standing': {
        need(1);
        const p = core.requirePrincipal(rest[0]!);
        // The same path as an on-demand card (Windows.askStanding): a card only for what none of their cards lists yet (P5).
        const windows = new Windows(core, config.resources, { graceMinutes: config.window_grace_minutes, maintenance: config.maintenance });
        if (windows.covers(p.id).length === 0) {
          throw new SwitchboardError('invalid', `${p.id} approves none of the configured resources, so a card would cover nothing. Check approvers and owners in config.yaml.`);
        }
        const s = windows.schedule();
        const offersOnly = values['offers-only'] === true;
        const card = windows.askStanding([p.id], undefined, { offersOnly })[0]!.card;
        core.audit('admin', 'ask_standing', { principal: p.id, version: s.version, card, ...(offersOnly ? { offers_only: true } : {}) });
        if (offersOnly && card === 'nothing_to_approve') { out(`nothing to offer ${p.id}: nobody else's approval covers what they can decide yet; nothing posted`); break; }
        out(card === 'posted' ? `posted ${p.id}'s standing-approval card for nightly maintenance ${span(s)} UTC (schedule v${s.version}); the service shows it in #ops on its next sweep, within a minute`
          : card === 'approved' ? `${p.id} already approved schedule v${s.version}; nothing posted`
          : `${p.id}'s card for schedule v${s.version} was already posted${card === 'waiting' ? '' : ` (they ${card} it; its Approve button still works)`}; nothing posted`);
        break;
      }
      case 'rerender-cards': {
        // Like ask-standing: this process has no Slack connection, so it marks the cards and the service's sweep edits them (P2).
        const windows = new Windows(core, config.resources, { graceMinutes: config.window_grace_minutes, maintenance: config.maintenance });
        const marked = windows.rerenderCards();
        core.audit('admin', 'rerender_cards', marked);
        out(`marked ${marked.windows.length + marked.cards.length} card(s) to re-render; the service rewrites each on its own Slack message on its next sweep, within a minute, and posts nothing:`);
        for (const w of marked.windows) out(`  urgent window ${w.id} (${w.resource}, ${w.state})`);
        for (const c of marked.cards) out(`  standing card ${c.id} (${c.approver}, schedule v${c.version})`);
        break;
      }
      case 'memory-revert': {
        need(1);
        const sha = await new Memory(join(contextDir(config), 'memory')).revert(rest[0]!);
        out(`reverted ${rest[0]} (new commit ${sha})`);
        break;
      }
      default:
        out(USAGE);
        return 2;
    }
    return 0;
  } catch (err) {
    if (err instanceof SwitchboardError) { out(`error: ${err.message}`); return 1; }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * systemd Type=notify + WatchdogSec (docs/runbook.md): READY once, then WATCHDOG=1 every 20 s, but only
 * while the event loop runs and the DB answers, so a wedged process gets restarted. Needs NotifyAccess=all.
 */
function watchdog(healthy: () => void): void {
  if (!process.env['NOTIFY_SOCKET']) return;
  const notify = (msg: string) => execFile('systemd-notify', [msg], (err) => { if (err) console.error('systemd-notify failed', err.message); });
  notify('--ready');
  setInterval(() => {
    try { healthy(); notify('WATCHDOG=1'); } catch (err) { console.error('health check failed; not petting the watchdog', err); }
  }, 20_000);
}

if (import.meta.main) {
  // On a failure, exit for sure: a serve that died halfway must not linger for systemd's start timeout.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
