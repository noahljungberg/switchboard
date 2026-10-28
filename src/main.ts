// Wiring: config + DB + core + Slack + agent MCP server in one process. `switchboard serve` calls
// start(); the e2e script calls it too, with a fake Slack port. Contract: docs/design/service.md.

import { mkdirSync, readFileSync } from 'node:fs';
import type http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createAgentHttpServer } from './agent-mcp.ts';
import type { Config, Secrets } from './config.ts';
import { ContextRepos, Memory } from './context.ts';
import { Core } from './core.ts';
import { openDb } from './db.ts';
import { ClaudeEngine, ClaudeSdkEngine, CodexEngine, type Engine } from './engines.ts';
import { OpsAgent, systemPrompt } from './ops.ts';
import { OpsMcp } from './ops-mcp.ts';
import { BoltSlack, SlackBridge, type SlackPort } from './slack.ts';
import { type StatusSource, StubStatus } from './status.ts';
import { Windows } from './windows.ts';

export interface StartOptions {
  config: Config;
  secrets: Secrets;
  /** Replaces Bolt (tests, e2e). */
  slack?: { port: SlackPort; botUserId: string };
  /** Replaces the configured engine chain (tests, e2e), in order of preference. */
  engines?: Engine[];
  /** Your system's own read-only status for the ops agent; a stub that says nothing is connected by default. */
  status?: StatusSource;
  now?: () => Date;
}

export interface Running {
  core: Core;
  windows: Windows;
  bridge: SlackBridge;
  agentUrl: string;
  ops?: Awaited<ReturnType<typeof startOps>> | undefined;
  stop(): Promise<void>;
}

export function dbPath(config: Config): string {
  mkdirSync(config.data_dir, { recursive: true, mode: 0o700 });
  return join(config.data_dir, 'switchboard.db');
}

export async function start(options: StartOptions): Promise<Running> {
  const { config, secrets } = options;
  const db = openDb(dbPath(config));
  // Teardown, in reverse order of setup. A start that fails halfway runs it too: otherwise a listening
  // server keeps the process up, half-wired and never READY, until systemd gives up on it.
  const undo: Array<() => unknown> = [() => db.close()];
  const stop = async (): Promise<void> => {
    while (undo.length) {
      try { await undo.pop()!(); } catch (err) { console.error('shutdown step failed', err); }
    }
  };
  try {
    const core = new Core(db, { researchDefault: config.research_lane_default, solicitedReplyHours: config.solicited_reply_hours, askExpiryMinutes: config.ask_expiry_minutes, ...(options.now ? { now: options.now } : {}) });
    const windows = new Windows(core, config.resources, { graceMinutes: config.window_grace_minutes, maintenance: config.maintenance });
    const named = new Set(config.resources.flatMap((r) => [...r.owners, ...(r.approvers ?? [])]));
    for (const p of named) if (!core.principal(p)) console.error(`config: resources name principal '${p}', who isn't added yet (switchboard admin add-principal).`);

    let bridge: SlackBridge;
    if (options.slack) {
      bridge = new SlackBridge({ core, port: options.slack.port, opsChannel: config.slack.ops_channel, botUserId: options.slack.botUserId, windows });
    } else {
      if (!secrets.slackBotToken || !secrets.slackAppToken) throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set (see .env.example).');
      const bolt = new BoltSlack(secrets.slackBotToken, secrets.slackAppToken);
      bridge = new SlackBridge({ core, port: bolt, opsChannel: config.slack.ops_channel, botUserId: await bolt.connect(), windows });
      undo.push(() => bolt.stop());
      await bolt.start(bridge);
    }
    bridge.start();

    const agentServer = createAgentHttpServer({ core, windows });
    const agentUrl = await listen(agentServer, config.listen.host, config.listen.port);
    undo.push(() => close(agentServer));

    // Apart, so a failing window clock can't stop idle pings, or the other way round.
    const tick = (): void => {
      try { windows.tick(); } catch (err) { console.error('window tick failed', err); }
      try { core.pingIdleAgents(config.idle_ping_minutes); } catch (err) { console.error('idle ping failed', err); }
      try { core.expireAsks(); } catch (err) { console.error('ask expiry failed', err); }
      try { core.expireSessions(); } catch (err) { console.error('session expiry failed', err); }
    };
    const timers = [setInterval(() => void bridge.sweep(), 60_000), setInterval(tick, 30_000)];
    for (const t of timers) t.unref();
    undo.push(() => { for (const t of timers) clearInterval(t); });

    const ops = config.ops ? await startOps(options, core, windows, undo) : undefined;
    return { core, windows, bridge, agentUrl, ops, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
}

export function listen(server: http.Server, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve(`http://${host.includes(':') ? `[${host}]` : host}:${p}`);
    });
  });
}

/** The context dir is the engine's whole filesystem view: repos/ (read-only checkouts) and memory/. */
export function contextDir(config: Config): string {
  return join(config.data_dir, 'context');
}

async function startOps(options: StartOptions, core: Core, windows: Windows, undo: Array<() => unknown>) {
  const { config, secrets } = options;
  const ops = config.ops!;
  const dir = contextDir(config);
  const memory = new Memory(join(dir, 'memory'));
  await memory.init(ops.memory_seed_dir ? resolve(dirname(config.path), ops.memory_seed_dir) : undefined);
  const repos = new ContextRepos({ dir: join(dir, 'repos'), repos: ops.context.repos, deployKeyPath: secrets.deployKeyPath });
  repos.start(ops.context.refresh_minutes * 60_000, (results) => {
    for (const r of results) if (r.error) console.error(`context repo ${r.name}: ${r.error}`);
  });
  undo.push(() => repos.stop());

  const mcp = new OpsMcp({ core, windows, status: options.status ?? new StubStatus(), memory });
  const server = mcp.createHttpServer();
  const url = await listen(server, '127.0.0.1', ops.mcp_port); // never the Tailscale interface
  undo.push(() => close(server));

  const timeoutMs = ops.turn_timeout_minutes * 60_000;
  const engines = options.engines ?? buildEngines(config, secrets, timeoutMs);
  const template = readFileSync(new URL('../prompts/ops.md', import.meta.url), 'utf8');
  const agent = new OpsAgent({
    core, windows, mcp, mcpUrl: `${url}/mcp`, engines,
    systemPrompt: () => systemPrompt(template, core, { resources: config.resources, repos: ops.context.repos.map((r) => r.name) }),
    contextDir: dir,
    failoverAfter: ops.failover_after_errors, maxConcurrent: ops.max_concurrent_turns, turnTimeoutMs: timeoutMs,
  });
  agent.start();
  undo.push(() => agent.stop());
  return { agent, mcp, url, memory, repos, server };
}

/** The configured chain (P7), skipping an engine whose credentials are missing, with a log line saying so. */
function buildEngines(config: Config, secrets: Secrets, timeoutMs: number): Engine[] {
  const ops = config.ops!;
  const engines: Engine[] = [];
  for (const kind of ops.engines) {
    if (kind === 'claude-api') {
      if (!secrets.anthropicApiKey) { console.error('ops engine claude-api skipped: ANTHROPIC_API_KEY is not set (docs/runbook.md §3)'); continue; }
      engines.push(new ClaudeSdkEngine({ apiKey: secrets.anthropicApiKey, model: ops.model, effort: ops.effort, home: join(config.data_dir, 'sdk-home'), runDir: join(config.data_dir, 'run'), timeoutMs }));
    } else if (kind === 'claude') {
      if (!secrets.claudeOauthToken) { console.error('ops engine claude skipped: CLAUDE_CODE_OAUTH_TOKEN is not set (docs/runbook.md §4)'); continue; }
      engines.push(new ClaudeEngine({ bin: ops.claude_bin, model: ops.model, effort: ops.effort, runDir: join(config.data_dir, 'run'), home: join(config.data_dir, 'claude-home'), oauthToken: secrets.claudeOauthToken, timeoutMs }));
    } else {
      engines.push(new CodexEngine({ bin: ops.codex.bin, model: ops.codex.model, effort: ops.codex.effort, codexHome: secrets.codexHome ?? join(config.data_dir, 'codex-home'), home: join(config.data_dir, 'codex-run'), timeoutMs }));
    }
  }
  if (engines.length === 0) throw new Error('no ops engine has credentials; set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or log in Codex');
  return engines;
}
