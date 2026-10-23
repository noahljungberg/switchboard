// Fakes for the thin interfaces (CONVENTIONS.md): Slack port, clock, engines, and a seeded world.
// Used by tests and by scripts/e2e.ts. No network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type ClientHints, Core, type CoreOptions, type ResearchDefault } from '../src/core.ts';
import { type Engine, EngineError, type TurnRequest, type TurnResult } from '../src/engines.ts';
import { openDb } from '../src/db.ts';
import type { Block, SlackPort, SlackPost } from '../src/slack.ts';
import type { Resource } from '../src/windows.ts';

export class FakeSlack implements SlackPort {
  posts: Array<SlackPost & { ts: string }> = [];
  updates: Array<{ channel: string; ts: string; text: string; blocks?: Block[] }> = [];
  ephemerals: Array<{ channel: string; user: string; text: string }> = [];
  failNext = 0;
  private n = 0;

  async post(msg: SlackPost): Promise<{ channel: string; ts: string }> {
    if (this.failNext > 0) { this.failNext--; throw new Error('fake slack: rate limited'); }
    const ts = `${1_700_000_000 + ++this.n}.000100`;
    this.posts.push({ ...msg, ts });
    return { channel: msg.channel, ts };
  }
  async update(msg: { channel: string; ts: string; text: string; blocks?: Block[] }): Promise<void> { this.updates.push(msg); }
  async ephemeral(msg: { channel: string; user: string; text: string }): Promise<void> { this.ephemerals.push(msg); }
  async openDm(slackUserId: string): Promise<string> { return `D${slackUserId}`; }

  /** All text posted to a channel, for assertions. */
  textIn(channel: string): string { return this.posts.filter((p) => p.channel === channel).map((p) => p.text).join('\n'); }
}

export class Clock {
  t: number;
  constructor(iso = '2026-10-14T12:00:00.000Z') { this.t = Date.parse(iso); }
  now = (): Date => new Date(this.t);
  advance(minutes: number): void { this.t += minutes * 60_000; }
}

export const SLACK = { alice: 'UALICE001', bob: 'UBOB00002', bot: 'UBOT00009', ops: 'COPS00001', stranger: 'USTRANGE1' } as const;

/** Two principals, two agents each, default-deny research lane. */
export function world(researchDefault: ResearchDefault = 'deny', options: Omit<CoreOptions, 'now' | 'researchDefault'> = {}) {
  const clock = new Clock();
  const core = new Core(openDb(':memory:'), { now: clock.now, researchDefault, ...options });
  core.addPrincipal('alice', 'Alice', SLACK.alice);
  core.addPrincipal('bob', 'Bob', SLACK.bob);
  const agents = {
    scout: core.addAgent('alice', 'scout'),
    builder: core.addAgent('alice', 'builder'),
    helper: core.addAgent('bob', 'helper'),
    analyst: core.addAgent('bob', 'analyst'),
  };
  const s = {
    scout: core.forAgent(agents.scout),
    builder: core.forAgent(agents.builder),
    helper: core.forAgent(agents.helper),
    analyst: core.forAgent(agents.analyst),
  };
  return { core, clock, agents, s };
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A temp dir, removed when the test (or suite, or file) that made it ends: /tmp may be RAM. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Session n's id, as Claude Code makes them (a uuid). */
export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** What a Claude client says about session n on a request: its key and its presence (core.forAgent's hints). */
export const hint = (n: number, presence: Record<string, unknown> = {}, extra: ClientHints = {}): ClientHints =>
  ({ session: `claude:${sid(n)}`, presence: encodeURIComponent(JSON.stringify(presence)), ...extra });

export async function mcpClient(url: string, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } }));
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; text: string; json: any }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = r.content[0]?.text ?? '';
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { error: !!r.isError, text, json };
}


/** The thread a rendered ops turn is for. */
export const turnThread = (req: TurnRequest): string => /Turn for thread (\S+)\./.exec(req.prompt)![1]!;

/**
 * An in-process engine that acts through the real ops MCP server with the turn's scoped token, the
 * way the claude/codex CLIs would. `act` plays the model; by default it answers "ack" in the thread.
 */
export class FakeEngine implements Engine {
  readonly kind: string;
  turns: TurnRequest[] = [];
  fail: (() => Error) | null = null;
  probeOk = true;
  act: (req: TurnRequest, mcp: Client) => Promise<void>;
  private n = 0;

  constructor(kind: string, act?: (req: TurnRequest, mcp: Client) => Promise<void>) {
    this.kind = kind;
    this.act = act ?? (async (req, mcp) => { await call(mcp, 'respond', { thread: turnThread(req), text: `ack from ${kind}` }); });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    this.turns.push(req);
    if (this.fail) throw this.fail();
    const mcp = await mcpClient(req.mcp.url.replace(/\/mcp$/, ''), req.mcp.token);
    try { await this.act(req, mcp); } finally { await mcp.close(); }
    return { session: req.session ?? `${this.kind}-session-${++this.n}`, text: '' };
  }

  async probe(): Promise<void> { if (!this.probeOk) throw new EngineError('still limited'); }
}

export const RESOURCES: Resource[] = [
  { id: 'api-gateway', name: 'API gateway', owners: ['alice', 'bob'], approvers: ['bob'], require: 'any', max_duration_minutes: 120,
    note: 'Waits until the on-call engineer confirms traffic is drained.' },
  { id: 'main-db', name: 'Main DB', owners: ['alice', 'bob'], approvers: ['alice', 'bob'], require: 'all', max_duration_minutes: 60 },
  { id: 'alice-box', name: 'Alice\'s staging box', owners: ['alice'], require: 'any', max_duration_minutes: 240 },
];

/** The value of a button on a posted card, as Slack sends it back when that button is pressed. */
export const buttonValue = (post: SlackPost, actionId: string): string => {
  const actions = (post.blocks ?? []).find((b) => b['type'] === 'actions') as { elements: Array<{ action_id: string; value: string }> } | undefined;
  const button = actions?.elements.find((e) => e.action_id === actionId);
  if (!button) throw new Error(`no ${actionId} button on: ${post.text.split('\n')[0]}`);
  return button.value;
};
