// The admin CLI against a temp data dir.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { loadConfig, parseConfig } from '../src/config.ts';
import { Core } from '../src/core.ts';
import { openDb } from '../src/db.ts';
import { dbPath, start } from '../src/main.ts';
import { SlackBridge } from '../src/slack.ts';
import { Windows } from '../src/windows.ts';
import { Clock, FakeSlack, SLACK, buttonValue, tempDir } from './fakes.ts';

export function tempConfig(extra = ''): string {
  const dir = tempDir('switchboard-');
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `listen: { host: 127.0.0.1, port: 0 }\ndata_dir: ${join(dir, 'data')}\nslack: { ops_channel: COPS00001 }\n${extra}`);
  return path;
}

async function run(config: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(['admin', '--config', config, ...args], (s) => lines.push(s));
  return { code, out: lines.join('\n') };
}

test('admin: principals, agents, tokens, mutes', async () => {
  const cfg = tempConfig();
  assert.equal((await run(cfg, 'add-principal', 'alice', '--name', 'Alice', '--slack', 'UALICE001')).code, 0);
  assert.equal((await run(cfg, 'add-principal', 'bob', '--name', 'Bob')).code, 0);
  const added = await run(cfg, 'add-agent', 'alice', 'scout');
  assert.match(added.out, /sb_[A-Za-z0-9_-]{43}/);
  assert.match((await run(cfg, 'list')).out, /mute bob ← alice: all/);
  assert.equal((await run(cfg, 'set-mute', 'bob', 'alice', 'relayed_only')).code, 0);
  assert.match((await run(cfg, 'list')).out, /mute bob ← alice: relayed_only/);
  assert.match((await run(cfg, 'issue-token', 'alice/scout')).out, /previous token no longer works/);
  assert.equal((await run(cfg, 'revoke-token', 'alice/scout')).code, 0);
  assert.match((await run(cfg, 'list')).out, /agent alice\/scout {2}REVOKED/);
  const bad = await run(cfg, 'set-mute', 'bob', 'alice', 'sometimes');
  assert.equal(bad.code, 1);
  assert.match(bad.out, /mode must be/);
  assert.equal((await run(cfg, 'add-agent', 'nobody', 'x')).code, 1);
});

test('admin set-delegate: only a live agent of that principal, none clears it, list shows it, each change audited (P4)', async () => {
  const cfg = tempConfig();
  await run(cfg, 'add-principal', 'alice', '--name', 'Alice', '--slack', SLACK.alice);
  await run(cfg, 'add-principal', 'bob', '--name', 'Bob');
  await run(cfg, 'add-agent', 'alice', 'claude');
  await run(cfg, 'add-agent', 'alice', 'old');
  await run(cfg, 'add-agent', 'bob', 'claude');
  await run(cfg, 'revoke-token', 'alice/old');
  assert.match((await run(cfg, 'list')).out, /principal alice {2}Alice {2}slack=UALICE001 {2}delegate=-/);
  for (const [agent, why] of [['bob/claude', /bob's agent; alice's delegate must be one of alice's own agents/], ['alice/old', /alice\/old is revoked/], ['alice/nobody', /no agent 'alice\/nobody'/]] as const) {
    const r = await run(cfg, 'set-delegate', 'alice', agent);
    assert.equal(r.code, 1, agent);
    assert.match(r.out, why, agent);
  }
  const set = await run(cfg, 'set-delegate', 'alice', 'alice/claude');
  assert.equal(set.code, 0, set.out);
  assert.match(set.out, /alice's delegate is alice\/claude: what other principals' agents address to alice goes to its inbox, not to alice/);
  assert.match((await run(cfg, 'list')).out, /principal alice {2}Alice {2}slack=UALICE001 {2}delegate=alice\/claude/);
  const cleared = await run(cfg, 'set-delegate', 'alice', 'none');
  assert.equal(cleared.code, 0);
  assert.match(cleared.out, /alice has no delegate: what other principals' agents address to alice goes to the ops agent, which tells alice what they need/);
  assert.match((await run(cfg, 'list')).out, /delegate=-/);
  assert.equal((await run(cfg, 'set-delegate', 'alice')).code, 1, 'needs both arguments');
  const db = openDb(dbPath(loadConfig(cfg)));
  assert.deepEqual(db.prepare("SELECT json_extract(detail, '$.agentId') AS agent FROM audit WHERE action = 'set_delegate' ORDER BY id").all().map((r) => ({ ...r })),
    [{ agent: 'alice/claude' }, { agent: null }]);
  db.close();
});

test('admin ask-standing: posts a principal\'s standing card through the on-demand path, and nothing while their cards list all they approve; audited; the service shows it', async () => {
  const cfg = tempConfig('resources:\n  - { id: core-api, name: Core API and DB, owners: [alice, bob], approvers: [alice], max_duration_minutes: 120 }\n');
  await run(cfg, 'add-principal', 'alice', '--name', 'Alice', '--slack', SLACK.alice);
  await run(cfg, 'add-principal', 'bob', '--name', 'Bob', '--slack', SLACK.bob);
  const first = await run(cfg, 'ask-standing', 'alice');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /posted alice's standing-approval card for nightly maintenance 21:00–23:00 UTC \(schedule v1\)/);
  const again = await run(cfg, 'ask-standing', 'alice');
  assert.equal(again.code, 0);
  assert.match(again.out, /alice's card for schedule v1 was already posted.*nothing posted/);
  const none = await run(cfg, 'ask-standing', 'bob'); // under this config only Alice approves anything
  assert.equal(none.code, 1);
  assert.match(none.out, /bob approves none of the configured resources/);
  assert.equal((await run(cfg, 'ask-standing', 'nobody')).code, 1);

  // The service (another process) posts the card on its next sweep, as it would an on-demand one.
  const config = loadConfig(cfg);
  let db = openDb(dbPath(config));
  const core = new Core(db);
  const windows = new Windows(core, config.resources, { maintenance: config.maintenance });
  const slack = new FakeSlack();
  const bridge = new SlackBridge({ core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot, windows });
  await bridge.sweep();
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0]!.text, `:calendar: <@${SLACK.alice}> Nightly maintenance 21:00–23:00 UTC for 1 shared resource (Alice's and Bob's agents). Approve once?`);
  await bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(slack.posts[0]!, 'sb_std_approve'), user: SLACK.alice, channel: SLACK.ops, messageTs: slack.posts[0]!.ts });
  assert.equal(windows.coverage(windows.resource('core-api'), 'alice').covered, true, 'approved before any change was queued');
  db.close();
  assert.match((await run(cfg, 'ask-standing', 'alice')).out, /alice already approved schedule v1; nothing posted/);
  db = openDb(dbPath(config));
  const audited = db.prepare("SELECT actor, json_extract(detail, '$.principal') AS principal, json_extract(detail, '$.card') AS card FROM audit WHERE action = 'ask_standing' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(audited, [['posted'], ['waiting'], ['approved']].map(([card]) => ({ actor: 'admin', principal: 'alice', card })));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM standing_cards').get() as { n: number }).n, 1, 'one card: nothing new to approve');
  db.close();
});

test('admin rerender-cards: the service rewrites every standing card and live urgent card in place in the current format, with the right buttons, and posts nothing; audited (P2)', async () => {
  const cfg = tempConfig('resources:\n' +
    '  - { id: gw, name: API gateway, owners: [alice, bob], approvers: [bob], max_duration_minutes: 120 }\n' +
    '  - { id: core-api, name: Core API and DB, owners: [alice, bob], approvers: [alice], max_duration_minutes: 120 }\n');
  await run(cfg, 'add-principal', 'alice', '--name', 'Alice', '--slack', SLACK.alice);
  await run(cfg, 'add-principal', 'bob', '--name', 'Bob', '--slack', SLACK.bob);
  const config = loadConfig(cfg);
  const clock = new Clock();
  const slack = new FakeSlack();
  const service = () => {
    const db = openDb(dbPath(config));
    const core = new Core(db, { now: clock.now });
    const windows = new Windows(core, config.resources, { maintenance: config.maintenance });
    const bridge = new SlackBridge({ core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot, windows });
    return { db, core, windows, bridge };
  };

  // The service posts cards as it runs: urgent windows proposed, approved, active and declined, and standing cards approved,
  // declined and voided by a new time.
  let { db, core, windows, bridge } = service();
  const scout = core.addAgent('alice', 'scout');
  const ask = (start: string, title: string) => windows.request(scout, { resource: 'gw', start, duration_minutes: 30, plan: `${title}. PLAN`, rollback: 'r', verify: 'v' });
  const press = (id: string, decision = 'approve') => bridge.onAction({ actionId: `sb_win_${decision}`, value: JSON.stringify({ w: id }), user: SLACK.bob, channel: SLACK.ops, messageTs: '1.1' });
  const proposed = ask('2026-10-14T15:00:00Z', 'Bump the gateway');
  const approved = ask('2026-10-14T16:00:00Z', 'Restart the gateway');
  const active = ask('2026-10-14T12:30:00Z', 'Patch the gateway');
  const declined = ask('2026-10-14T17:00:00Z', 'Drop the gateway');
  for (const w of [approved, active]) await press(w.window);
  await press(declined.window, 'decline');
  windows.queue(scout, { resource: 'gw', plan: 'p', rollback: 'r', verify: 'v' });
  windows.queue(scout, { resource: 'core-api', plan: 'p', rollback: 'r', verify: 'v' });
  await bridge.sweep();
  const std = (approver: string) => slack.posts.find((p) => p.text.includes(`<@${SLACK[approver as 'alice' | 'bob']}> Nightly`))!;
  const v1 = std('alice');
  await bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(v1, 'sb_std_approve'), user: SLACK.alice, channel: SLACK.ops, messageTs: v1.ts });
  windows.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops:alice'); // voids v1; the queued changes post v2 cards
  await bridge.sweep();
  const v2 = slack.posts.filter((p) => p.text.includes('Nightly maintenance 22:00–00:00 UTC for'));
  const bob2 = v2.find((p) => p.text.includes(`<@${SLACK.bob}>`))!;
  const alice2 = v2.find((p) => p.text.includes(`<@${SLACK.alice}>`))!;
  await bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(bob2, 'sb_std_approve'), user: SLACK.bob, channel: SLACK.ops, messageTs: bob2.ts });
  await bridge.onAction({ actionId: 'sb_std_decline', value: buttonValue(alice2, 'sb_std_decline'), user: SLACK.alice, channel: SLACK.ops, messageTs: alice2.ts });
  clock.advance(31); // 12:31: the active window starts
  windows.tick();
  await bridge.sweep();
  // One card from before migration 10: its request event has no title (the row has migration 10's), and a Slack can no longer
  // edit another (a card old enough that chat.update is refused).
  const legacy = core.createThread({ kind: 'window', visibility: 'shared', title: 'Window: Core API and DB', participants: ['agent:alice/scout'], slack: { channel: SLACK.ops, ts: '500.1' } });
  db.prepare(`INSERT INTO windows (id, resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all, state, created_at, title)
    VALUES (?, 'core-api', 'alice/scout', '2026-10-14T18:00:00.000Z', '2026-10-14T18:45:00.000Z', 'Raise API rate limits. Then PLAN', 'r', 'v', '["alice"]', 0, 'proposed', ?, 'Raise API rate limits')`).run(legacy.id, clock.now().toISOString());
  core.append(legacy.id, 'agent:alice/scout', 'window_requested', { window: legacy.id, resource: 'core-api', resource_name: 'Core API and DB', note: null,
    start: '2026-10-14T18:00:00.000Z', end: '2026-10-14T18:45:00.000Z', minutes: 45, plan: 'Raise API rate limits. Then PLAN', rollback: 'r', verify: 'v', approvers: ['alice'], require: 'any' });
  core.setSlackSynced(legacy.id, 1);
  const root = (id: string) => core.thread(id)!.slack_ts!;
  const cardTs = { proposed: root(proposed.window), approved: root(approved.window), active: root(active.window), declined: root(declined.window), legacy: '500.1',
    v1: v1.ts, bob2: bob2.ts, alice2: alice2.ts, bob1: std('bob').ts };
  db.close();

  // The operator runs it from another process: it marks the cards, and says so.
  const marked = await run(cfg, 'rerender-cards');
  assert.equal(marked.code, 0, marked.out);
  assert.match(marked.out, /marked 8 card\(s\) to re-render; the service rewrites each on its own Slack message on its next sweep, within a minute, and posts nothing:/);
  for (const id of [proposed.window, approved.window, active.window, legacy.id]) assert.match(marked.out, new RegExp(`urgent window ${id}`));
  assert.doesNotMatch(marked.out, new RegExp(declined.window), 'a declined window is no longer live');
  assert.match(marked.out, /standing card \d+ \(bob, schedule v2\)/);

  // The service's next sweep rewrites them.
  ({ db, core, windows, bridge } = service());
  const posts = slack.posts.length;
  const updates = slack.updates.length;
  const refused = cardTs.bob1;
  const update = slack.update.bind(slack);
  slack.update = async (msg) => { if (msg.ts === refused) throw Object.assign(new Error('An API error occurred: cant_update_message'), { data: { ok: false, error: 'cant_update_message' } }); return update(msg); };
  await bridge.sweep();
  assert.equal(slack.posts.length, posts, 'nothing posted, not even for the card Slack refused to edit');
  const rewrites = slack.updates.slice(updates);
  const buttons = (ts: string) => {
    const u = rewrites.find((x) => x.ts === ts);
    assert.ok(u, `rewrote ${ts}`);
    return [u.text, ((u.blocks ?? []).find((b) => b['type'] === 'actions') as { elements: Array<{ action_id: string }> } | undefined)?.elements.map((e) => e.action_id) ?? []];
  };
  assert.deepEqual(buttons(cardTs.proposed), [`:wrench: <@${SLACK.bob}> API gateway, 15:00–15:30 UTC: \`Bump the gateway\` (scout, Alice's agent)`, ['sb_win_approve', 'sb_win_decline']]);
  assert.deepEqual(buttons(cardTs.approved), [':white_check_mark: API gateway, 16:00–16:30 UTC: `Restart the gateway`. Approved by Bob.', []]);
  assert.deepEqual(buttons(cardTs.active), [':construction: API gateway, 12:30–13:00 UTC: `Patch the gateway`. In progress until 13:00.', []]);
  assert.deepEqual(buttons(cardTs.legacy), [`:wrench: <@${SLACK.alice}> Core API and DB, 18:00–18:45 UTC: \`Raise API rate limits\` (scout, Alice's agent)`, ['sb_win_approve', 'sb_win_decline']]);
  assert.deepEqual(buttons(cardTs.bob2), [':calendar: Nightly maintenance 22:00–00:00 UTC. Approved by Bob.', ['sb_std_revoke']]);
  assert.deepEqual(buttons(cardTs.alice2), [':calendar: Nightly maintenance 22:00–00:00 UTC. Declined by Alice.', ['sb_std_approve']]);
  assert.deepEqual(buttons(cardTs.v1), [':calendar: Nightly maintenance 21:00–23:00 UTC. Void: the slot moved to 22:00–00:00 UTC.', []]);
  assert.ok(!rewrites.some((u) => u.ts === cardTs.declined), 'a decided window is left as it is');
  assert.equal(rewrites.length, 7, 'one rewrite per card Slack could edit');
  for (const u of rewrites) assert.equal((u.blocks ?? []).at(-1)?.['type'], 'context', 'each keeps the switchboard footer');
  assert.ok(!rewrites.some((u) => /PLAN/.test(u.text)));
  const behind = db.prepare('SELECT COUNT(*) AS n FROM threads t WHERE t.slack_synced_seq < (SELECT MAX(seq) FROM events e WHERE e.thread_id = t.id)').get() as { n: number };
  assert.equal(behind.n, 0, 'the mirror moved on, the refused card included');
  const audit = db.prepare("SELECT actor, json_array_length(json_extract(detail, '$.windows')) AS windows, json_array_length(json_extract(detail, '$.cards')) AS cards FROM audit WHERE action = 'rerender_cards'").all().map((r) => ({ ...r }));
  assert.deepEqual(audit, [{ actor: 'admin', windows: 4, cards: 4 }], 'one audit row');
  db.close();
});

test('the runbook says what rerender-cards rewrites and what it leaves alone', async () => {
  const { readFileSync } = await import('node:fs');
  const runbook = readFileSync(new URL('../docs/runbook.md', import.meta.url), 'utf8');
  const section = runbook.slice(runbook.indexOf('**Re-render the cards'));
  assert.match(section, /Declined,\s+done\s+and\s+expired\s+windows\s+are\s+left\s+alone/, 'approved and active ones are re-rendered');
  assert.match(section, /only\s+each\s+card's\s+root\s+message,\s+not\s+copies\s+the\s+ops\s+agent\s+re-posted\s+under\s+it/);
});

test('every SQL query in the runbook runs on a migrated DB', async () => {
  const { readFileSync } = await import('node:fs');
  const runbook = readFileSync(new URL('../docs/runbook.md', import.meta.url), 'utf8');
  const queries = [...runbook.matchAll(/sqlite3 \S+ "([^"]+)"/g)].map((m) => m[1]!).filter((q) => !q.startsWith('.')); // .backup is a shell command
  assert.ok(queries.length >= 4, queries.join('\n'));
  const db = openDb(':memory:');
  for (const q of queries) assert.doesNotThrow(() => db.prepare(q).all(), q);
  db.close();
});

test('config.example.yaml is a valid config', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const { parseConfig } = await import('../src/config.ts');
  const config = parseConfig(parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8')));
  assert.ok(config.resources.length > 0);
  assert.equal(config.research_lane_default, 'deny');
  assert.equal(config.ask_expiry_minutes, 60, 'P3: an unpresented ask expires after an hour by default');
});

test('admin usage: ops turns and API-credit spend this month, by engine', async () => {
  const cfg = tempConfig();
  await run(cfg, 'add-principal', 'alice', '--name', 'Alice');
  const { openDb } = await import('../src/db.ts');
  const { loadConfig } = await import('../src/config.ts');
  const { dbPath } = await import('../src/main.ts');
  const db = openDb(dbPath(loadConfig(cfg)));
  const at = new Date().toISOString();
  for (const [engine, cost] of [['claude-api', 0.5], ['claude-api', 0.25], ['codex', undefined]] as const) {
    db.prepare("INSERT INTO audit (at, actor, action, detail) VALUES (?, 'ops', 'turn', ?)").run(at, JSON.stringify({ engine, ...(cost ? { cost_usd: cost } : {}) }));
  }
  db.close();
  const out = (await run(cfg, 'usage')).out;
  assert.match(out, /claude-api: 2 turns, \$0\.75 of API credits/);
  assert.match(out, /codex: 1 turns/);
});

test('the e2e script removes its temp dir even when the service fails to start', async () => {
  const tmp = tempDir('switchboard-'); // the script's TMPDIR, so what it leaves is easy to see
  // Every listen fails, as a refused bind would.
  const refuse = `data:text/javascript,${encodeURIComponent('import http from "node:http"; http.Server.prototype.listen = function () { process.nextTick(() => this.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }))); return this; };')}`;
  const { code, err } = await new Promise<{ code: number | null; err: string }>((done) => {
    const child = spawn(process.execPath, ['--import', refuse, new URL('../scripts/e2e.ts', import.meta.url).pathname], { env: { ...process.env, TMPDIR: tmp } });
    let e = '';
    child.stderr.on('data', (c) => { e += c; });
    child.on('close', (c) => done({ code: c, err: e }));
  });
  assert.notEqual(code, 0);
  assert.match(err, /EADDRINUSE/);
  assert.deepEqual(readdirSync(tmp), [], 'nothing left behind');
});

test('a start that fails halfway closes what it opened instead of hanging half-started', async () => {
  const free = createServer();
  const port = await new Promise<number>((r) => free.listen(0, '127.0.0.1', () => r((free.address() as { port: number }).port)));
  await new Promise((r) => free.close(r));
  const dir = tempDir('switchboard-');
  // The agent MCP server is listening by the time the ops engine chain turns out to have no credentials.
  const config = parseConfig({ listen: { host: '127.0.0.1', port }, data_dir: join(dir, 'data'), slack: { ops_channel: SLACK.ops }, ops: { mcp_port: 0, engines: ['claude-api'] } }, join(dir, 'config.yaml'));
  await assert.rejects(start({ config, secrets: {}, slack: { port: new FakeSlack(), botUserId: SLACK.bot } }), /no ops engine has credentials/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'the agent MCP server was closed');
});
