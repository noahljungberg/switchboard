// Engine adapters against stub CLIs (test/stubs): the argv allowlist, the clean environment, the MCP
// config handling, quota detection and session recovery. No network, no real model.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, ClaudeSdkEngine, CodexEngine, EngineError, OPS_MODEL, SessionLostError, claudeArgs, parseResetAt } from '../src/engines.ts';
import { tempDir } from './fakes.ts';

const STUB = (name: string) => new URL(`./stubs/${name}`, import.meta.url).pathname;
const tmp = () => tempDir('sb-engine-');
const req = (cwd: string, session: string | null = null) => ({ session, prompt: 'Turn for thread t_1.', systemPrompt: 'You are the ops agent.', mcp: { url: 'http://127.0.0.1:9/mcp', token: 'ops_secret' }, cwd });
const records = (home: string) => readdirSync(home).filter((f) => f.startsWith('record-')).sort().map((f) => JSON.parse(readFileSync(join(home, f), 'utf8')));

describe('claude argv', () => {
  const args = claudeArgs({ session: 's', fresh: true, model: OPS_MODEL, effort: 'high', systemPrompt: 'sys', mcpConfigPath: '/x.json' });
  const flag = (name: string) => args[args.indexOf(name) + 1];

  test('is Opus 5.5 with only the ops MCP server and read-only file tools', () => {
    assert.equal(flag('--model'), 'claude-opus-5-5');
    assert.equal(flag('--tools'), 'Read,Grep,Glob');
    assert.equal(flag('--allowedTools'), 'mcp__switchboard-ops,Read,Grep,Glob');
    assert.match(flag('--disallowedTools')!, /Bash.*Edit.*Write.*WebFetch.*WebSearch/);
    assert.equal(flag('--permission-mode'), 'dontAsk');
    assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config'));
  });

  test('never carries a permission-bypass flag', () => {
    const joined = args.join(' ');
    for (const bad of ['bypassPermissions', 'dangerously', 'danger-full-access', '--add-dir']) assert.ok(!joined.includes(bad), bad);
  });

  test('refuses any model but the configured one (P8)', () => {
    assert.throws(() => new ClaudeEngine({ model: 'claude-opus-5', runDir: tmp(), home: tmp() }), /ops engine model must be claude-opus-5-5, the configured model/); // check-arch: allow-model (proves the guard refuses it)
  });
});

describe('quota errors', () => {
  test('are recognised, with the reset time when the CLI gives one', () => {
    const now = new Date('2026-10-14T13:05:00Z');
    const e = new EngineError("You've hit your usage limit · resets 3pm (UTC)", now);
    assert.equal(e.quota, true);
    assert.equal(e.resetAt?.toISOString(), '2026-10-14T15:00:00.000Z');
    assert.equal(parseResetAt('Claude AI usage limit reached|1792000000', now)?.toISOString(), new Date(1792000000 * 1000).toISOString());
    assert.equal(parseResetAt('limit reached, resets 9am', now)?.toISOString(), '2026-10-15T09:00:00.000Z', 'already past today: tomorrow');
    assert.equal(new EngineError('ECONNRESET').quota, false);
  });
});

describe('ClaudeEngine with a stub CLI', () => {
  test('runs a turn with a 0600 MCP config it deletes afterwards and an env without service secrets', async () => {
    const home = tmp(); const runDir = tmp(); const cwd = tmp();
    process.env['SLACK_BOT_TOKEN'] = 'not-for-the-engine';
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir, home, oauthToken: 'oauth-123' });
    const r = await engine.turn(req(cwd));
    delete process.env['SLACK_BOT_TOKEN'];
    assert.equal(r.text, 'done');
    const [rec] = records(home);
    assert.equal(rec.cwd, cwd);
    assert.equal(rec.mcp.mode, '600');
    assert.deepEqual(rec.mcp.content, { mcpServers: { 'switchboard-ops': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer ops_secret' } } } });
    assert.equal(existsSync(rec.mcp.path), false, 'config with the token is gone after the turn');
    assert.ok(rec.envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    assert.ok(!rec.envKeys.includes('SLACK_BOT_TOKEN'));
    assert.equal(rec.args[rec.args.indexOf('--session-id') + 1], r.session, 'fresh turn names its session');
  });

  test('a usage-limit result is a quota EngineError', async () => {
    const home = tmp();
    writeFileSync(join(home, 'mode'), 'quota');
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir: tmp(), home });
    await assert.rejects(engine.turn(req(tmp(), 'abc')), (e: unknown) => e instanceof EngineError && e.quota);
  });

  test('a lost session is a SessionLostError, so the ops agent starts over with the whole thread (test/ops.test.ts)', async () => {
    const home = tmp();
    writeFileSync(join(home, 'mode'), 'noconv');
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir: tmp(), home });
    await assert.rejects(engine.turn(req(tmp(), 'gone-session')), SessionLostError);
    assert.deepEqual(records(home).map((x) => x.args.includes('--resume')), [true], 'no silent retry with only the new events');
  });

  test('the prompt goes on stdin, so a thread bigger than one argv string (128 KiB) still runs', async () => {
    const home = tmp();
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir: tmp(), home });
    const prompt = `Turn for thread t_1.\n${'chatter '.repeat(25_000)}`; // 200 KB
    const r = await engine.turn({ ...req(tmp()), prompt });
    assert.equal(r.text, 'done');
    const [rec] = records(home);
    assert.equal(rec.stdin, prompt);
    assert.ok(!rec.args.some((a: string) => a.includes('Turn for thread')), 'no part of the prompt is in argv');
  });

  test('a CLI that can\'t even be spawned is an EngineError', async () => {
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir: tmp(), home: tmp() });
    // A 200 KB system prompt is over the per-argv-string limit, so spawn() itself throws (E2BIG).
    await assert.rejects(engine.turn({ ...req(tmp()), systemPrompt: 'x'.repeat(200 * 1024) }), (e: unknown) => e instanceof EngineError && /E2BIG/.test(e.message));
  });

  test('a crash is a non-quota EngineError carrying the CLI\'s last words', async () => {
    const home = tmp();
    writeFileSync(join(home, 'mode'), 'crash');
    const engine = new ClaudeEngine({ bin: STUB('fake-claude.mjs'), runDir: tmp(), home });
    await assert.rejects(engine.turn(req(tmp())), (e: unknown) => e instanceof EngineError && !e.quota && /segfault-ish/.test(e.message));
  });
});

describe('CodexEngine with a stub app-server', () => {
  const lines = (home: string) => readFileSync(join(home, 'codex-record.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  test('read-only sandbox, never asks for approval, declines any that come, same MCP server', async () => {
    const home = tmp();
    // The stub finishes a turn only once the engine answers its approval request: fail fast if it never does.
    const engine = new CodexEngine({ bin: STUB('fake-codex.mjs'), codexHome: tmp(), home, timeoutMs: 10_000 });
    const r = await engine.turn(req(tmp()));
    assert.deepEqual(r, { session: 'th_new', text: 'codex says hi' });
    const sent = lines(home);
    const start = sent.find((m) => m.method === 'thread/start').params;
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.config.mcp_servers['switchboard-ops'].url, 'http://127.0.0.1:9/mcp');
    assert.equal(start.config.features.shell_tool, false);
    assert.deepEqual(sent.find((m) => m.id === 500).result, { decision: 'decline' });
    assert.match(sent.find((m) => m.method === 'turn/start').params.input[0].text, /^You are the ops agent\./, 'fresh thread gets the system prompt');
  });

  test('the probe runs a one-word turn with no tools, so a logged-out or limited Codex fails it', async () => {
    const home = tmp();
    const engine = new CodexEngine({ bin: STUB('fake-codex.mjs'), codexHome: tmp(), home, timeoutMs: 10_000 });
    await engine.probe();
    const sent = lines(home);
    assert.ok(sent.some((m) => m.method === 'turn/start'), 'a real turn, not only initialize');
    const start = sent.find((m) => m.method === 'thread/start').params;
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.config.mcp_servers, undefined, 'no MCP server for a probe');
    writeFileSync(join(home, 'codex-mode'), 'fail');
    await assert.rejects(engine.probe(), (e: unknown) => e instanceof EngineError && e.quota);
  });

  test('a stale thread is a SessionLostError; a kept thread resumes; a failed turn is an EngineError', async () => {
    const home = tmp();
    const engine = new CodexEngine({ bin: STUB('fake-codex.mjs'), codexHome: tmp(), home, timeoutMs: 10_000 });
    await assert.rejects(engine.turn(req(tmp(), 'stale')), SessionLostError);
    assert.ok(!lines(home).some((m) => m.method === 'turn/start'), 'no silent fresh thread with only the new events');
    assert.equal((await engine.turn(req(tmp(), 'th_kept'))).session, 'th_kept');
    writeFileSync(join(home, 'codex-mode'), 'fail');
    await assert.rejects(engine.turn(req(tmp(), 'th_kept')), (e: unknown) => e instanceof EngineError && e.quota);
  });
});

describe('ClaudeSdkEngine (Agent SDK on API credits) with a fake query()', () => {
  const fakeQuery = (results: Array<(Record<string, unknown> & { type: string }) | Error>, seen: any[]) =>
    (p: { prompt: string; options?: Options }) => {
      seen.push(p);
      const r = results.shift()!;
      return (async function* () { if (r instanceof Error) throw r; yield { type: 'system' }; yield r; })();
    };

  test('passes the same confinement as the CLI and reports the cost', async () => {
    const seen: any[] = [];
    // engineEnv passes LANG and TZ through, so pin them: the runner's own environment must not change the expected keys.
    const saved = { LANG: process.env['LANG'], TZ: process.env['TZ'] };
    Object.assign(process.env, { SLACK_BOT_TOKEN: 'not-for-the-engine', LANG: 'C.UTF-8', TZ: 'UTC' });
    const runDir = tmp();
    const engine = new ClaudeSdkEngine({ apiKey: 'sk-test', home: tmp(), runDir, query: fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-1', total_cost_usd: 0.042 }], seen) });
    const r = await engine.turn(req(tmp())).finally(() => {
      delete process.env['SLACK_BOT_TOKEN'];
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    assert.deepEqual(r, { session: 's-1', text: 'done', costUsd: 0.042 });
    const o = seen[0].options;
    assert.equal(o.model, 'claude-opus-5-5');
    assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob']);
    assert.deepEqual(o.allowedTools, ['mcp__switchboard-ops', 'Read', 'Grep', 'Glob']);
    assert.equal(o.permissionMode, 'dontAsk');
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.extraArgs.restricted, null);
    assert.equal(o.mcpServers, undefined, 'the SDK would put mcpServers, token and all, in argv');
    assert.equal(join(o.extraArgs['mcp-config'], '..'), runDir, 'the MCP config is a file in the private run dir');
    assert.deepEqual(Object.keys(o.env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'HOME', 'LANG', 'PATH', 'TZ'].filter((k) => k !== 'PATH' || process.env['PATH']).sort());
    assert.equal(o.resume, undefined, 'fresh turn');
    assert.ok(!JSON.stringify(o).includes('bypass'));
  });

  test('exhausted credits are a credits EngineError with no reset time; a lost session is a SessionLostError', async () => {
    const seen: any[] = [];
    const engine = new ClaudeSdkEngine({ apiKey: 'sk-test', home: tmp(), runDir: tmp(), query: fakeQuery([
      { type: 'result', subtype: 'success', is_error: true, result: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', session_id: 'x' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: old'], session_id: 'x' },
    ], seen) });
    await assert.rejects(engine.turn(req(tmp())), (e: unknown) => e instanceof EngineError && e.credits && e.quota && e.resetAt === null);
    await assert.rejects(engine.turn(req(tmp(), 'old')), SessionLostError);
    assert.deepEqual(seen.slice(1).map((p) => p.options.resume), ['old'], 'no silent retry with only the new events');
  });

  test('the ops token never reaches the CLI\'s argv, which any local user can read in /proc (real SDK, stub CLI)', async () => {
    const home = tmp();
    const engine = new ClaudeSdkEngine({ apiKey: 'sk-test', home, runDir: tmp(), timeoutMs: 20_000,
      query: (p) => query({ ...p, options: { ...p.options, pathToClaudeCodeExecutable: STUB('fake-claude.mjs') } }) });
    await engine.turn(req(tmp())).catch(() => {}); // the stub doesn't speak the SDK's control protocol; only its argv matters
    const [rec] = records(home);
    assert.ok(rec, 'the SDK ran the stub');
    assert.ok(!JSON.stringify(rec.args).includes('ops_secret'), `token in argv: ${rec.args.join(' ')}`);
    assert.equal(rec.mcp.mode, '600');
    assert.deepEqual(rec.mcp.content, { mcpServers: { 'switchboard-ops': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer ops_secret' } } } });
    assert.equal(existsSync(rec.mcp.path), false, 'config with the token is gone after the turn');
    assert.ok(rec.args.includes('--strict-mcp-config') && rec.args.includes('--restricted'));
  });

  test('refuses any model but the configured one (P8)', () => {
    assert.throws(() => new ClaudeSdkEngine({ apiKey: 'k', home: tmp(), runDir: tmp(), model: 'claude-fable-5-1' }), /ops engine model must be claude-opus-5-5, the configured model/); // check-arch: allow-model (proves the guard refuses it)
  });
});
