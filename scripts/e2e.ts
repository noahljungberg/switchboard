// Scripted end-to-end run: the real wiring (src/main.ts start()) with a fake Slack port, real HTTP MCP
// clients, a temp data dir. Prints each step; exits non-zero on the first failed check.
// Run: npm run e2e

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig } from '../src/config.ts';
import { start } from '../src/main.ts';
import { EngineError } from '../src/engines.ts';
import { Clock, FakeEngine, FakeSlack, SLACK, buttonValue, call as mcpCall, turnThread } from '../test/fakes.ts';

const log = (step: string, detail = ''): void => console.log(`✔ ${step}${detail ? `  ${detail}` : ''}`);

async function client(url: string, token: string): Promise<Client> {
  const c = new Client({ name: 'e2e', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = r.content[0]?.text ?? '';
  return r.isError ? { error: text } : JSON.parse(text);
}

const dir = mkdtempSync(join(tmpdir(), 'switchboard-e2e-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true })); // however the run ends, a failed start included
const config = parseConfig({
  listen: { host: '127.0.0.1', port: 0 }, data_dir: join(dir, 'data'), slack: { ops_channel: SLACK.ops },
  resources: [{ id: 'api-gateway', name: 'API gateway', owners: ['alice', 'bob'], approvers: ['bob'], max_duration_minutes: 120,
    note: 'Waits until the on-call engineer confirms traffic is drained.' }],
  ops: { mcp_port: 0 },
});
// Fake engines play the model through the real ops MCP server (scripts/smoke-engine.ts runs the real ones).
// The e2e chain is subscription → Codex; test/ops.test.ts covers the full API-credits → subscription → Codex chain.
const SECRET = 'PLUM-77';
const primary = new FakeEngine('claude', async (req, mcp) => {
  const thread = turnThread(req);
  // P3: what agents wrote for a human waits in the turn header; the ops agent tells them in its own words.
  const items = [...req.prompt.matchAll(/"item":"(m_[0-9a-f]{12})","for":"([a-z]+)"/g)];
  if (items.length) { await mcpCall(mcp, 'tell_human', { principal: items[0]![2], text: 'Your overnight batch job finished. Nothing to do.', items: items.map((m) => m[1]) }); return; }
  const asks = [...req.prompt.matchAll(/"ask":"(q_[0-9a-f]{12})"/g)];
  if (asks.length) { await mcpCall(mcp, 'present_ask', { ask_id: asks[0]![1], text: 'Restart the staging box now? Your batch job pauses for 10 minutes.' }); return; }
  if (req.prompt.includes('"kind":"dm"')) { await mcpCall(mcp, 'respond', { thread, text: 'Noted; this stays in our DM.' }); return; }
  if (!req.prompt.includes('scheduled today')) { await mcpCall(mcp, 'do_not_respond', { thread, reason: 'the card says it all' }); return; }
  const windows = (await mcpCall(mcp, 'list_windows')).json as Array<{ resource: string; state: string; start: string; end: string }>;
  const dmProbe = await mcpCall(mcp, 'search_threads', { query: SECRET });
  const lines = windows.map((w) => `${w.resource} ${w.start.slice(11, 16)}–${w.end.slice(11, 16)} UTC (${w.state})`);
  await mcpCall(mcp, 'respond', { thread, text: `Today: ${lines.join('; ') || 'nothing'}. Gateway restart: waits until @bob confirms traffic is drained; no status source is connected. (DM search hits: ${dmProbe.json.length})` });
});
const failover = new FakeEngine('codex');
const clock = new Clock('2026-10-14T12:00:00Z');
const slack = new FakeSlack();
const sb = await start({ config, secrets: {}, slack: { port: slack, botUserId: SLACK.bot }, engines: [primary, failover], now: clock.now });
const settle = async () => { for (let i = 0; i < 4; i++) { await sb.ops!.agent.idle(); await sb.bridge.sweep(); } };
const inThread = (ts: string) => slack.posts.filter((p) => p.threadTs === ts).map((p) => p.text).join('\n');

try {
  // ---- M1: two principals' agents talk; mutes hold; the shared thread shows up in Slack ----
  sb.core.addPrincipal('alice', 'Alice', SLACK.alice);
  sb.core.addPrincipal('bob', 'Bob', SLACK.bob);
  sb.core.addAgent('alice', 'scout');
  sb.core.addAgent('bob', 'helper');
  const scout = await client(sb.agentUrl, sb.core.issueToken('alice/scout'));
  const helper = await client(sb.agentUrl, sb.core.issueToken('bob/helper'));
  log('M1 two principals, one agent each, tokens issued', sb.agentUrl);

  const refused = await call(scout, 'send_message', { to: 'bob/helper', body: 'hello' });
  assert.match(refused.error, /^muted: /);
  log('M1 default-deny research lane refuses the cross-principal send', refused.error.slice(0, 70) + '…');

  sb.core.setMute('bob', 'alice', 'none');
  const sent = await call(scout, 'send_message', { to: 'bob/helper', body: 'Is the staging box free after 15:00?' });
  assert.equal(sent.status, 'delivered');
  const inbox = await call(helper, 'read_inbox');
  assert.equal(inbox.items[0].from_agent, 'alice/scout');
  assert.equal(inbox.items[0].from_principal, 'alice');
  log('M1 bob unmutes alice; helper reads scout\'s message wrapped as data', JSON.stringify({ from_agent: inbox.items[0].from_agent, from_principal: inbox.items[0].from_principal, body: inbox.items[0].body }));

  await call(helper, 'post', { thread: sent.thread, body: 'Yes, take it.' });
  await settle();
  assert.equal(slack.posts.length, 0);
  log('M1 agent-to-agent chat stays out of Slack (P3)', '0 posts');

  sb.core.setMute('bob', 'alice', 'all');
  assert.match((await call(scout, 'post', { thread: sent.thread, body: 'one more' })).not_delivered.muted[0], /helper/);
  log('M1 mute re-applied: later posts in the thread are not delivered, and the sender is told');

  // ---- M2: an urgent window is approved only by Bob's button, then runs on the clock ----
  const win = await call(scout, 'request_window', { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, urgent: true,
    plan: 'Bump the API gateway to the patched build.', rollback: 'Revert to the previous image.', verify: 'curl -fsS gateway/health; clients reconnect' });
  assert.equal(win.state, 'proposed');
  await settle();
  const buttons = slack.posts.find((p) => p.blocks && p.text.startsWith(':wrench:'))!;
  assert.equal(buttons.text, `:wrench: <@${SLACK.bob}> API gateway, 14:00–14:30 UTC: \`Bump the API gateway to the patched build\` (scout, Alice's agent). ` +
    'Waits until the on-call engineer confirms traffic is drained.');
  log('M2 request_window → shared window thread + a one-line Slack card with buttons (P2)', `approvers=${win.approvers.join(',')}; "${buttons.text}"`);

  const agreed = await call(helper, 'post', { thread: win.window, body: 'Approved from my side, go ahead.' });
  assert.equal(agreed.status, 'posted');
  assert.equal((await call(scout, 'window_status', { id: win.window })).state, 'proposed');
  log('M2 Bob\'s agent "approving" in the thread changes nothing', 'state still proposed');

  const press = (user: string) => sb.bridge.onAction({ actionId: 'sb_win_approve', value: JSON.stringify({ w: win.window }), user, channel: SLACK.ops, messageTs: buttons.ts });
  await press(SLACK.alice);
  assert.equal((await call(scout, 'window_status', { id: win.window })).state, 'proposed');
  log('M2 Alice presses Approve: refused', slack.ephemerals.at(-1)!.text);
  await press(SLACK.bob);
  assert.equal((await call(scout, 'window_status', { id: win.window })).state, 'approved');
  await settle(); // the new window woke the ops agent; jumping the fake clock mid-turn would expire its token
  const card = () => slack.updates.filter((u) => u.ts === buttons.ts).at(-1)!.text;
  assert.match(card(), /Approved by Bob/);
  log('M2 Bob presses Approve: approved, written on the card itself (P5)', card().split('\n').at(-1));

  clock.advance(120); sb.windows.tick();
  const status = await call(scout, 'window_status', { resource: 'api-gateway' });
  assert.equal(status.may_proceed, true);
  log('M2 14:00 tick → active; window_status may_proceed', status.reason);
  const report = await call(scout, 'report_window', { id: win.window, outcome: 'done', evidence: 'gateway/health 200; 3/3 clients reconnected' });
  assert.equal(report.state, 'done');
  await settle();
  assert.equal(card(), ':white_check_mark: API gateway, 14:00–14:30 UTC: `Bump the API gateway to the patched build`. Done.');
  assert.equal(slack.posts.filter((p) => p.ts === buttons.ts || p.threadTs === buttons.ts).length, 1, 'the card is the window\'s only post');
  assert.doesNotMatch([...slack.posts, ...slack.updates].map((p) => p.text).join('\n'), /Revert to|curl|3\/3 clients/, 'rollback, verify and evidence stay out of Slack (P2)');
  log('M2 report_window → done, one word on the card; the window was one Slack post (P5, P2)', card());

  // ---- M3: the ops agent answers in Slack, keeps DMs out of shared sessions, fails over out loud ----
  await call(scout, 'request_window', { resource: 'api-gateway', start: '2026-10-14T16:00:00Z', duration_minutes: 30, urgent: true, plan: 'p', rollback: 'r', verify: 'v' });
  await settle();
  const humanChatter = primary.turns.length;
  await sb.bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bob}> lunch?`, ts: '700.1' });
  await settle();
  assert.equal(primary.turns.length, humanChatter);
  log('M3 human-to-human message without a bot mention: no wake', `${humanChatter} turns before and after`);

  await sb.bridge.onMessage({ channel: `D${SLACK.bob}`, channelType: 'im', user: SLACK.bob, text: `between us: ${SECRET}`, ts: '701.1' });
  await sb.bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> what's scheduled today and is anything blocking a gateway restart?`, ts: '702.1' });
  await settle();
  const answer = inThread('702.1');
  assert.match(answer, /api-gateway 16:00–16:30 UTC \(proposed\)/);
  assert.match(answer, /DM search hits: 0/);
  assert.ok(!slack.textIn(SLACK.ops).includes(SECRET));
  assert.ok(primary.turns.filter((t) => !t.prompt.includes('"kind":"dm"')).every((t) => !t.prompt.includes(SECRET)));
  log('M3 mention → ops answers in the thread', answer.replace(/\n/g, ' '));
  log('M3 DM content is in no shared prompt, search result or #ops post');

  // ---- P3: an agent's words reach its human only through the ops agent ----
  const toAlice = await call(scout, 'send_message', { to: 'alice', body: 'JOB-77 done: batch B7 shard 2 rate 0.41 vs 0.63 pre-reconnect' });
  assert.equal(toAlice.via, 'the ops agent');
  await settle();
  const dmText = slack.textIn(`D${SLACK.alice}`);
  assert.equal(dmText, 'Your overnight batch job finished. Nothing to do.');
  assert.doesNotMatch([...slack.posts, ...slack.updates].map((p) => p.text).join('\n'), /JOB-77|batch B7|shard 2/, 'none of the agent\'s words');
  log('P3 an agent writes to Alice: the ops agent tells her in her DM, in its own words; nothing of the agent\'s reaches Slack', dmText);

  const asked = await call(scout, 'ask_human', { who: 'alice', question: 'RB-2 bounce stg-box i-0abc now? B7 load test pauses', options: ['yes', 'not now'] });
  assert.equal(asked.status, 'asked');
  await settle();
  const askCard = slack.posts.filter((p) => p.channel === `D${SLACK.alice}` && p.blocks).at(-1)!;
  assert.equal(askCard.text, 'Restart the staging box now? Your batch job pauses for 10 minutes.');
  await sb.bridge.onAction({ actionId: 'sb_ask_1', value: buttonValue(askCard, 'sb_ask_1'), user: SLACK.alice, channel: askCard.channel, messageTs: askCard.ts });
  const answered = (await call(scout, 'read_inbox')).items.find((i: { type: string }) => i.type === 'human_answer');
  assert.equal(answered.body.answer, 'not now');
  assert.doesNotMatch([...slack.posts, ...slack.updates].map((p) => p.text).join('\n'), /RB-2|i-0abc|B7/, 'none of the agent\'s words');
  log('P3 an agent asks Alice: the ops agent presents it in its words with the agent\'s buttons; her press reaches the agent', `${askCard.text} → ${answered.body.answer}`);

  primary.fail = () => new EngineError("You've hit your usage limit · resets 3pm (UTC)", clock.now());
  await sb.bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> still there?`, ts: '703.1' });
  await settle();
  assert.match(inThread('703.1'), /Running on Codex \(subscription\): Claude \(subscription\) usage limit until 15:00 UTC/);
  assert.match(inThread('703.1'), /ack from codex/);
  log('M3 forced quota error → announced failover, answered on Codex', inThread('703.1').split('\n')[0]!);

  // ---- P5: agents queue changes for the nightly slot; one standing approval; one summary ----
  const turns = primary.turns.length + failover.turns.length;
  const posts = slack.posts.length;
  const queued = await call(scout, 'request_window', { resource: 'api-gateway', plan: 'Roll the gateway to build 1a2b.', rollback: 'Roll back to the previous build.', verify: 'curl -fsS gateway/health' });
  assert.match(queued.change, /^c_/);
  assert.equal(queued.covered, false);
  await settle();
  const stdCard = slack.posts.slice(posts).find((p) => p.text.includes('Approve once?'))!;
  assert.equal(stdCard.text, `:calendar: <@${SLACK.bob}> Nightly maintenance 21:00–23:00 UTC for 1 shared resource (Alice's and Bob's agents). Approve once?`);
  assert.equal(slack.posts.length, posts + 1, 'the change itself posts nothing; Bob\'s card is posted once');
  await call(helper, 'request_window', { resource: 'api-gateway', plan: 'Restart the gateway.', rollback: 'Start the old unit.', verify: 'curl -fsS gateway/health' });
  await settle();
  assert.equal(slack.posts.length, posts + 1, 'a later change posts nothing');
  log('P5 request_window queues changes, no windows; one standing card for Bob', queued.next.split(': ')[1]);

  const std = (user: string) => sb.bridge.onAction({ actionId: 'sb_std_approve', value: buttonValue(stdCard, 'sb_std_approve'), user, channel: SLACK.ops, messageTs: stdCard.ts });
  await std(SLACK.alice);
  assert.match(slack.ephemerals.at(-1)!.text, /this card is Bob's/);
  await std(SLACK.bob);
  await settle();
  assert.equal(slack.updates.filter((u) => u.ts === stdCard.ts).at(-1)!.text, ':calendar: Nightly maintenance 21:00–23:00 UTC. Approved by Bob.');
  log('P5 Alice\'s press on Bob\'s card is refused; Bob approves the schedule once, the card says so', slack.ephemerals.at(-1)!.text);

  assert.equal((await call(scout, 'window_status', { resource: 'api-gateway' })).may_proceed, false);
  clock.t = Date.parse('2026-10-14T21:10:00Z'); sb.windows.tick();
  const go = await call(scout, 'window_status', { resource: 'api-gateway' });
  assert.equal(go.may_proceed, true);
  assert.equal(go.change, queued.change);
  log('P5 21:10: window_status may_proceed inside the approved slot', go.reason);
  await call(scout, 'report_window', { id: queued.change, outcome: 'done', evidence: 'gateway/health 200 on 1a2b' });
  await settle();
  assert.equal(slack.posts.length, posts + 1, 'the report posts nothing');
  clock.advance(140); sb.windows.tick(); // 23:30 = end + grace
  await settle();
  const summary = slack.posts.slice(posts + 1);
  assert.equal(summary.length, 1);
  assert.ok(summary[0]!.text.length <= 300, 'the cap on system notices (P2)');
  assert.equal(primary.turns.length + failover.turns.length, turns, 'no ops turn for queued changes, approvals or the slot');
  log('P5 23:30: one summary for the slot, nothing else', summary[0]!.text);

  // ---- Sessions: mail to an agent targets its online session, whose client's /wait wakes it ----
  sb.core.addAgent('alice', 'builder');
  const session = { Authorization: `Bearer ${sb.core.issueToken('alice/builder')}`, 'X-Switchboard-Session': 'claude:00000000-0000-4000-8000-0000000000e2',
    'X-Switchboard-Presence': encodeURIComponent(JSON.stringify({ repo: 'webapp', branch: 'main', status: 'idle' })) };
  const poll = (seconds: number) => fetch(`${sb.agentUrl}/wait?timeout_s=${seconds}`, { headers: session }).then((r) => r.json());
  assert.deepEqual(await poll(1), { wake: [] });
  const woken = poll(30);
  const toBuilder = await call(scout, 'send_message', { to: 'builder', body: 'Is the migration on main?' });
  assert.deepEqual(toBuilder.delivery, { to: 'alice/builder@webapp', tier: 'push' });
  assert.deepEqual(await woken, { wake: [{ session: 'claude:00000000-0000-4000-8000-0000000000e2', unread: 1, steer: 0 }] });
  assert.equal((await call(scout, 'list_team')).sessions[0].address, 'alice/builder@webapp');
  log('Sessions: mail targets the online session and its /wait returns a wake at once; list_team shows it', JSON.stringify(toBuilder.delivery));

  await scout.close(); await helper.close();
  console.log('\nE2E PASSED');
} catch (err) {
  console.error('\nE2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await sb.stop();
}
