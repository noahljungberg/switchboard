// The agent MCP server over real HTTP on loopback: auth, the hook endpoint, and the tools.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createAgentHttpServer } from '../src/agent-mcp.ts';
import { listen } from '../src/main.ts';
import { call, mcpClient, sid, world } from './fakes.ts';

describe('agent MCP over HTTP', () => {
  const w = world('open');
  const server = createAgentHttpServer({ core: w.core });
  let url = '';
  const tokens = { scout: w.core.issueToken('alice/scout'), helper: w.core.issueToken('bob/helper') };
  before(async () => { url = await listen(server, '127.0.0.1', 0); });
  after(() => { server.closeAllConnections(); server.close(); });

  test('rejects missing and wrong tokens, and logs the failure', async () => {
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${url}/unread`, { headers: { Authorization: 'Bearer sb_nope' } })).status, 401);
    assert.ok(w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth_failed'").get()!['n']! as number >= 2);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });

  test('exposes the Claude Code-style tool names', async () => {
    const c = await mcpClient(url, tokens.scout);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_human', 'list_agents', 'list_team', 'post', 'read_inbox', 'read_thread', 'send_message', 'wait_for_message', 'whoami']);
    await c.close();
  });

  test('send_message, ask_human and whoami say a human of the other principal may have a delegate agent (P4)', async () => {
    const c = await mcpClient(url, tokens.scout);
    const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    assert.match(tools.get('send_message')!, /another principal's human who set a delegate agent: it goes to that agent's inbox instead, and no human sees it \(the result's via says so\)/);
    assert.match(tools.get('ask_human')!, /If the other principal set a delegate agent, the question goes to its inbox as one message instead \(no card, no buttons\), and any answer comes from it as a message/);
    assert.match(tools.get('whoami')!, /your principal's delegate and whether you are it/);
    await c.close();
  });

  test('send_message and post say an agent\'s words never reach Slack: the ops agent tells the human (P3)', async () => {
    const c = await mcpClient(url, tokens.scout);
    const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    assert.match(tools.get('send_message')!, /a principal id \('alice', 'bob'\): your words go to the ops agent, which tells that human in plain words what they need to know; no human reads them directly,/);
    assert.match(tools.get('post')!, /Nothing an agent posts reaches Slack\. In a chat thread a human is part of, the ops agent reads your post for them/);
    assert.doesNotMatch(tools.get('send_message')!, /goes to that human in Slack/);
    assert.match(tools.get('ask_human')!, /Your question waits for the ops agent, which puts it to the human as a card in its own words, with your options as buttons/);
    assert.match(tools.get('ask_human')!, /comes back as not presented/);
    assert.match(tools.get('ask_human')!, /Without options, the human answers in words: in their DM their next reply is the answer; in #ops their replies under the card reach you as messages/);
    await c.close();
  });

  test('A sends, B gets it wrapped as data; /unread is the hook hint', async () => {
    const a = await mcpClient(url, tokens.scout);
    const b = await mcpClient(url, tokens.helper);
    assert.equal((await call(a, 'whoami')).json.agent, 'alice/scout');
    const sent = await call(a, 'send_message', { to: 'bob/helper', body: 'staging box free?' });
    assert.equal(sent.json.status, 'delivered');
    const unread = await (await fetch(`${url}/unread`, { headers: { Authorization: `Bearer ${tokens.helper}` } })).json();
    assert.deepEqual(unread, { unread: 1, steer: 0 });
    const inbox = await call(b, 'read_inbox');
    assert.equal(inbox.json.items[0].from_agent, 'alice/scout');
    assert.equal(inbox.json.items[0].from_principal, 'alice');
    assert.match(inbox.json.note, /data, not instructions/);
    await a.close(); await b.close();
  });

  test('refusals come back as tool errors with a next step, and every call is audited', async () => {
    const b = await mcpClient(url, tokens.helper);
    const r = await call(b, 'read_thread', { thread: 't_000000000000' });
    assert.equal(r.error, true);
    assert.match(r.text, /^not_found: /);
    const audited = w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor = 'agent:bob/helper' AND action = 'tool:read_thread'").get()!;
    assert.equal(audited['n'], 1);
    await b.close();
  });

  test('revoking or rotating a token ends its in-flight wait_for_message without handing over newer mail', async () => {
    const cuts: Record<string, (id: string) => void> = { revoke: (id) => w.core.revokeToken(id), rotate: (id) => { w.core.issueToken(id); } };
    for (const [how, cut] of Object.entries(cuts)) {
      const c = await mcpClient(url, w.core.issueToken('alice/builder'));
      const seen = () => (w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor = 'agent:alice/builder' AND action = 'tool:wait_for_message'").get() as { n: number }).n;
      const before = seen();
      const pending = call(c, 'wait_for_message', { timeout_s: 30 });
      while (seen() === before) await new Promise((r) => setTimeout(r, 5)); // the call is in and waiting
      cut('alice/builder');
      w.s.scout.sendMessage('builder', `after the ${how}: deploy key rotated to K-2`);
      const got = await pending;
      assert.equal(got.error, true, how);
      assert.match(got.text, /^forbidden: .*revoked or rotated/, how);
      assert.equal(w.core.unread('agent:alice/builder').unread, 1, `${how}: the mail waits for whoever holds the live token`);
      w.s.builder.readInbox();
      await c.close();
    }
  });

  test('a token revoked after its request was authenticated runs no tool', async () => {
    const { thread } = w.s.scout.sendMessage('builder', 'private note');
    w.s.builder.readInbox();
    const authenticate = w.core.authenticate.bind(w.core);
    // One raw tools/call per try, so exactly one request is authenticated (a client's handshake would be too).
    const toolCall = (token: string, name: string, args: Record<string, unknown>) => fetch(`${url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }).then(async (r) => ((await r.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    const tries: Record<string, Record<string, unknown>> = { send_message: { to: 'scout', body: 'sent after the revoke' }, read_thread: { thread } };
    for (const [name, args] of Object.entries(tries)) {
      const token = w.core.issueToken('alice/builder');
      // The revoke lands after the request is authenticated and before its tool runs (the body is handled later).
      w.core.authenticate = (t) => { const agent = authenticate(t); if (agent) w.core.revokeToken(agent.id); return agent; };
      const text = await toolCall(token, name, args).finally(() => { w.core.authenticate = authenticate; });
      assert.match(text, /^forbidden: .*revoked or rotated/, name);
    }
    assert.equal(w.s.scout.readInbox().length, 0, 'nothing was sent');
  });

  test('a revoked token stops working on the next request', async () => {
    const t = w.core.issueToken('bob/analyst');
    const c = await mcpClient(url, t);
    assert.equal((await call(c, 'whoami')).json.agent, 'bob/analyst');
    w.core.revokeToken('bob/analyst');
    await assert.rejects(call(c, 'whoami'));
  });
});

describe('sessions and wake over HTTP', () => {
  const w = world('open');
  const server = createAgentHttpServer({ core: w.core });
  let url = '';
  const tokens = { builder: w.core.issueToken('alice/builder'), helper: w.core.issueToken('bob/helper') };
  before(async () => { url = await listen(server, '127.0.0.1', 0); });
  after(() => { server.closeAllConnections(); server.close(); });
  /** What the switchboard client sends: the bearer, its host, its presence, and (Claude) its session. */
  const headers = (token: string, n: number | null, presence: Record<string, unknown> = {}, host = 'box-1'): Record<string, string> => ({
    Authorization: `Bearer ${token}`, 'X-Switchboard-Host': host, 'X-Switchboard-Presence': encodeURIComponent(JSON.stringify(presence)),
    ...(n === null ? {} : { 'X-Switchboard-Session': `claude:${sid(n)}` }),
  });
  const get = async (path: string, h: Record<string, string>): Promise<{ status: number; json: { wake?: unknown[] } }> => {
    const r = await fetch(`${url}${path}`, { headers: h });
    return { status: r.status, json: await r.json() };
  };
  /** One raw tools/call, as a stateless client (Codex) sends it, with its _meta. */
  const toolCall = (h: Record<string, string>, name: string, meta: Record<string, unknown>) => fetch(`${url}/mcp`, {
    method: 'POST', headers: { ...h, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {}, _meta: meta } }),
  }).then(async (r) => JSON.parse(((await r.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text));

  test('session headers name the session: whoami shows its address, and every result but the inbox\'s carries its unread counts; a client without them works as today', async () => {
    const c = await mcpClient(url, tokens.builder, headers(tokens.builder, 1, { cwd: '/w/webapp', repo: 'webapp', branch: 'main', status: 'idle', title: 'Fix login' }));
    const plain = await mcpClient(url, tokens.builder);
    const first = await call(c, 'whoami');
    assert.equal(first.json.session, 'alice/builder@webapp');
    assert.equal(first.json.inbox, undefined, 'no mail: no counts');
    w.s.scout.sendMessage('builder', 'hello');
    assert.deepEqual((await call(c, 'whoami')).json.inbox, { unread: 1, steer: 0 });
    const listed = (await c.callTool({ name: 'list_agents', arguments: {} })) as { content: Array<{ text: string }> };
    assert.ok(Array.isArray(JSON.parse(listed.content[0]!.text)), 'list_agents is unchanged');
    assert.deepEqual(JSON.parse(listed.content[1]!.text), { inbox: { unread: 1, steer: 0 } }, 'a list gets its counts next to it');
    const old = await call(plain, 'whoami');
    assert.equal(old.json.session, undefined);
    assert.equal(old.json.inbox, undefined, 'a caller with no session: results as before');
    const read = await call(c, 'read_inbox');
    assert.equal(read.json.inbox, undefined);
    assert.deepEqual(read.json.items.map((i: { body: { text: string } }) => i.body.text), ['hello']);
    await c.close(); await plain.close();
  });

  test('Codex names its thread in every tools/call (_meta.threadId), which is its session, on the host the client says', async () => {
    const meta = { threadId: sid(50), 'x-codex-turn-metadata': { session_id: sid(50), thread_id: sid(50) }, progressToken: 1 };
    assert.equal((await toolCall(headers(tokens.builder, null, { repo: 'api' }, 'box-9'), 'whoami', meta)).session, 'alice/builder@api');
    assert.equal((await toolCall(headers(tokens.builder, null, {}, 'box-9'), 'whoami', { 'x-codex-turn-metadata': { thread_id: sid(51) } })).session, 'alice/builder@codex', 'the turn metadata\'s thread_id too');
    assert.deepEqual(w.core.db.prepare("SELECT key, host FROM sessions WHERE key LIKE 'codex:%' ORDER BY id").all().map((r) => ({ ...r })),
      [{ key: `codex:${sid(50)}`, host: 'box-9' }, { key: `codex:${sid(51)}`, host: 'box-9' }]);
  });

  test('GET /wait: a wake for the caller\'s own session once mail for it arrives; it never reads mail; each message wakes once; untargeted mail and a busy session never wake', async () => {
    const idle = headers(tokens.builder, 2, { repo: 'w2', status: 'idle' });
    assert.deepEqual(await get('/wait?timeout_s=1', idle), { status: 200, json: { wake: [] } });
    const pending = get('/wait?timeout_s=30', idle);
    w.s.scout.sendMessage('alice/builder@w2', 'wake up');
    assert.deepEqual(await pending, { status: 200, json: { wake: [{ session: `claude:${sid(2)}`, unread: 1, steer: 0 }] } });
    assert.equal(w.core.unread('agent:alice/builder').unread, 1, 'nothing was read');
    assert.deepEqual((await get('/wait?timeout_s=1', idle)).json, { wake: [] }, 'one wake per message');

    const busy = headers(tokens.builder, 2, { repo: 'w2', status: 'busy' });
    assert.deepEqual((await get('/wait?timeout_s=1', busy)).json, { wake: [] });
    w.s.scout.sendMessage('alice/builder@w2', 'while busy');
    assert.deepEqual((await get('/wait?timeout_s=1', busy)).json, { wake: [] }, 'busy: no wake');
    assert.deepEqual((await get('/wait?timeout_s=30', idle)).json, { wake: [{ session: `claude:${sid(2)}`, unread: 2, steer: 0 }] }, 'idle again: woken at once');

    w.clock.advance(3); // no session online: the next message is untargeted
    w.s.scout.sendMessage('builder', 'for anyone');
    assert.deepEqual((await get('/wait?timeout_s=1', idle)).json, { wake: [] }, 'untargeted mail never wakes');
    w.s.builder.readInbox(100);
  });

  test('GET /wait from a Codex client (no session header) reaches only the codex sessions it names in X-Switchboard-Threads, and only one of two clients claims a wake', async () => {
    await toolCall(headers(tokens.helper, null, { repo: 'api' }, 'box-9'), 'whoami', { threadId: sid(60) });
    await toolCall(headers(tokens.helper, null, { repo: 'closed' }, 'box-9'), 'whoami', { threadId: sid(61) }); // same host; its Codex has since closed
    const polled = (n: number) => w.core.db.prepare('SELECT polled_at FROM sessions WHERE key = ?').get(`codex:${sid(n)}`)!['polled_at'];
    // Its own thread, one that doesn't exist, another agent's (alice/builder's, from the test above), and junk: only the first counts.
    const named = { ...headers(tokens.helper, null, {}, 'box-9'), 'X-Switchboard-Threads': [sid(60), sid(99), sid(50), 'not-a-thread'].join(',') };
    assert.deepEqual((await get('/wait?timeout_s=1', named)).json, { wake: [] });
    assert.equal(polled(61), null, 'the thread it doesn\'t name isn\'t marked online');
    assert.equal(polled(50), null, 'nor another agent\'s');
    const both = [get('/wait?timeout_s=2', named), get('/wait?timeout_s=2', named)];
    const sent = w.s.scout.sendMessage('bob/helper', 'for codex');
    assert.deepEqual((await Promise.all(both)).map((r) => r.json.wake).flat(), [{ session: `codex:${sid(60)}`, unread: 1, steer: 0 }], 'one claim, for the named thread');
    assert.equal(w.core.db.prepare('SELECT s.key FROM inbox i JOIN sessions s ON s.id = i.session WHERE i.thread_id = ? AND i.event_seq = ?').get(sent.thread, sent.seq)!['key'], `codex:${sid(60)}`);
    w.core.forAgent(w.agents.analyst).sendMessage('bob/helper@closed', 'for the closed thread');
    assert.deepEqual((await get('/wait?timeout_s=1', named)).json, { wake: [] }, 'never woken by a client that doesn\'t name it');
    assert.equal(polled(61), null);
    w.s.helper.readInbox(100);
  });

  test('GET /unread with a session: its counts and its own (targeted) mail, presence recorded, and the notices it backs tell the session; without one, exactly as before', async () => {
    const hook = (event: string) => get(`/unread?${new URLSearchParams({ session: `claude:${sid(3)}`, event, cwd: '/w/hooked/src', repo: 'hooked', branch: 'dev', host: 'box-1' })}`,
      { Authorization: `Bearer ${tokens.builder}` });
    assert.deepEqual(await hook('UserPromptSubmit'), { status: 200, json: { unread: 0, steer: 0, targeted: 0 } });
    assert.deepEqual({ ...w.core.db.prepare(`SELECT name, cwd, repo, branch, host, status, hooks FROM sessions WHERE key = 'claude:${sid(3)}'`).get() },
      { name: 'hooked', cwd: '/w/hooked/src', repo: 'hooked', branch: 'dev', host: 'box-1', status: 'busy', hooks: 1 });
    w.core.forAgent(w.agents.scout).sendMessage('alice/builder@hooked', 'for the hooked session');
    w.clock.advance(3);
    w.s.scout.sendMessage('builder', 'for anyone');
    assert.deepEqual((await get('/unread', { Authorization: `Bearer ${tokens.builder}` })).json, { unread: 2, steer: 0 }, 'the old hook\'s call: unchanged');
    assert.deepEqual((await hook('Stop')).json, { unread: 2, steer: 0, targeted: 1 });
    assert.equal(w.core.db.prepare(`SELECT status FROM sessions WHERE key = 'claude:${sid(3)}'`).get()!['status'], 'idle');
    assert.deepEqual((await get('/wait?timeout_s=1', headers(tokens.builder, 3))).json, { wake: [] }, 'the Stop block told it: no wake repeats it');
    w.s.builder.readInbox(100);
  });

  test('GET /unread for PostToolUse names the thread a switchboard write went to, from a session whose MCP config sends none: it becomes the session\'s route; a thread it can\'t read sets nothing; the counts are as always and nothing is told', async () => {
    const h = { Authorization: `Bearer ${tokens.builder}` };
    const hook = (q: Record<string, string>) => get(`/unread?${new URLSearchParams({ session: `claude:${sid(8)}`, ...q })}`, h);
    await hook({ event: 'Stop', cwd: '/w/routed' }); // the session, as its hooks make it on the old HTTP MCP config
    const session = w.core.db.prepare(`SELECT id, name FROM sessions WHERE key = 'claude:${sid(8)}'`).get() as { id: number; name: string };
    const mine = w.s.builder.sendMessage('helper', 'a write that names no session').thread;
    assert.equal(w.core.route(mine, 'alice/builder'), undefined, 'the write itself noted no route');
    const theirs = w.s.helper.sendMessage('analyst', 'bob\'s own').thread;
    w.core.forAgent(w.agents.scout).sendMessage(`alice/builder@${session.name}`, 'targeted, not yet told');
    const told = () => (w.core.db.prepare('SELECT COUNT(*) AS n FROM inbox_told WHERE session = ?').get(session.id) as { n: number }).n;
    const counts = await hook({});
    assert.deepEqual(await hook({ event: 'PostToolUse', thread: mine }), counts, 'the counts, as always');
    assert.equal(w.core.route(mine, 'alice/builder'), session.id, 'the thread it wrote in is its route now');
    for (const thread of [theirs, 't_000000000000', 'general', '']) assert.deepEqual(await hook({ event: 'PostToolUse', thread }), counts, `ignored: '${thread}'`);
    assert.equal(w.core.route(theirs, 'alice/builder'), undefined, 'a thread it can\'t read sets nothing');
    assert.equal(told(), 0, 'PostToolUse tells nothing');
    w.s.builder.readInbox(100);
    // Online (its rewaker polls /wait), the route beats a more recently active idle session: the reply goes to it.
    await Promise.all([get('/wait?timeout_s=1', headers(tokens.builder, 8)), get('/wait?timeout_s=1', headers(tokens.builder, 9))]);
    w.s.helper.post(mine, 'the reply');
    const row = w.core.db.prepare("SELECT session FROM inbox WHERE recipient = 'agent:alice/builder' AND thread_id = ? ORDER BY id DESC LIMIT 1").get(mine) as { session: number | null };
    assert.equal(row.session, session.id);
    w.s.builder.readInbox(100);
  });

  test('a /wait whose client hangs up stops waiting and leaves no waiter behind', async () => {
    const waiters = () => w.core['waiters'].get('agent:alice/builder')?.size ?? 0;
    const until = async (ok: () => boolean) => { for (const end = Date.now() + 5000; !ok(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timed out'); };
    const before = waiters();
    const hangUp = new AbortController();
    const held = fetch(`${url}/wait?timeout_s=30`, { headers: headers(tokens.builder, 5), signal: hangUp.signal }).then(() => 'answered', () => 'hung up');
    await until(() => waiters() === before + 1);
    hangUp.abort();
    assert.equal(await held, 'hung up');
    await until(() => waiters() === before);
  });

  test('GET /wait takes timeout_s from 1 to 55', async () => {
    for (const t of ['0', '56', 'x', '1.5']) assert.equal((await get(`/wait?timeout_s=${t}`, headers(tokens.builder, 4))).status, 400, t);
    assert.equal((await fetch(`${url}/wait`)).status, 401);
  });
});
