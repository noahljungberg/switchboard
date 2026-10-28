# Design: Ops agent

## Purpose

The one agent every principal shares (plan §1.3, §6, §7). It talks to humans in Slack, summarizes windows,
relays the `relayed_only` lane, and keeps a memory of standing rules. It is the voice, never the authority
(P6): it has no tool that approves, changes prod, or reads a principal's private threads.

## Public API

- `src/wake.ts`: `wakeReason(event, thread)`, pure. Called by `Core.append`, which writes an `ops`
  inbox row (kind = the reason) in the same transaction as the event.

  | Wakes it | Doesn't |
  |---|---|
  | a DM; a Slack message mentioning the bot | human-to-human chatter, including untagged replies in a thread it spoke in (P2); its own messages; notices; anything in a private (non-DM) thread |
  | `send_message(to: ops)`; what an agent writes for a human (`for_human`, P3: `send_message` to a human, a `post` in a chat thread a human is part of) and its questions (`ask_human`, P3); a relay request; a new urgent window or incident; an alert from the status source (`status_alert`, not built yet, M4) | agent-to-agent messages; an urgent window's decision, clock (start, end, expiry, overdue) and report, which only rewrite its card or page the human (P5) |

- `src/ops.ts`: `OpsAgent` — `start()`, `drain()`, `schedule(thread)`, `idle()`, `render(thread, reasons,
  fresh)`, `activeEngine()`, `session(thread, engine)`; `systemPrompt(template, core, config)` (prompts/ops.md + roster).
- `src/engines.ts`: `Engine` (`turn`, `probe`), `ClaudeSdkEngine` (+ `claudeSdkOptions`), `ClaudeEngine`
  (+ `claudeArgs`), `CodexEngine`, `EngineError` (`quota`, `credits`, `resetAt`), `SessionLostError`, `QUOTA`, `CREDITS`,
  `parseResetAt`, `engineEnv`, `OPS_MODEL`.
- `src/ops-mcp.ts`: `OpsMcp` — `mint(scope, ttlMs)`, `renew(token, ttlMs)`, `revoke(token)`, `createHttpServer()` (loopback). Tools:
  `respond`, `do_not_respond`, `read_thread`, `search_threads`, `list_windows`, `list_maintenance` (P5: the schedule, the next slot, standing approvals,
  the queue), `list_agents`,
  `request_approval`, `relay`, `set_maintenance_time` (P5: only in a shared turn a human's own #ops message woke,
  the turn's `asker`, so no agent can steer it into voiding approvals; moves the nightly slot, which voids the
  standing approvals and is announced by switchboard), `status_health`, `status_live`,
  `status_overview`, `status_events` (an optional status source, a stub by default: [status.md](status.md)), `memory_read`, `memory_propose`, `message_agents` (P1: only in a turn
  that one human's own Slack messages alone woke, a mention or a DM, and only to that human's agents; see below),
  `tell_human(principal, text, items?)` (P3: one message from the ops agent: in a DM turn, that human's DM, only the
  DM's own human; in a shared turn, a new top-level #ops post that tags them, with the items' agents in its thread,
  where the post and the human's replies reach the session that wrote each item; the 500-character cap (P2); marks
  the items told), `respond` and `do_not_respond` with `items?` (told in that thread; skipped with the
  reason), each item handled only from a turn that can write its thread (`OpsMcp.items`), once,
  `present_ask(ask_id, text)` (P3: an agent's pending ask as a card, the ops agent's one line of at most 300
  characters with the agent's own options as buttons; it can't change them or answer; the same thread rule as items;
  `do_not_respond` with an ask's id drops it and tells the asker why; an ask left pending expires after
  `ask_expiry_minutes` and the asker is told "not presented"),
  `set_my_mute(mode, toward)` (P1: the same `asker` check; through `Core.setOwnMute`, it sets `mutes(asker → toward)`,
  what reaches the asker's agents, never another principal's side; audited as `ops:<asker>` with `asked`, the human's
  own Slack words; every change posts one fixed system notice, with the footer, in the asker's DM ("Your agents now hear
  Alice's agents: directly (changed by the ops agent at your request). Reply @ops to undo."; a mute adds what still gets
  through: "Still: replies to what your agents send them from now on (for 24 h)", and, when the other side has a
  delegate, "and your agents' messages to Alice reach Alice's delegate"); returns one line to confirm,
  which also says the other side is unchanged. Only `ops-mcp.ts` may call `Core.setOwnMute`, and only `cli.ts` and the
  e2e script `Core.setMute`, arch check). `respond` (P2: Slack-bound text is one paragraph of at most 500 characters, or it is refused with a how-to-fix error) posts to the thread and the agents in it
  get it; Slack shows it per P3 (`docs/design/slack.md`): in a thread a human is part of, always; in an
  agents-only thread, only a message that tags a human, which pages them (the first page is a new top-level
  post, later ones go under it; a human who replies there joins the thread). Its tool description says so,
  and it returns where the text went: `slack: 'thread' | 'paged' | 'agents_only'`. `relay` returns the same.
- `src/context.ts`: `ContextRepos` (`syncOnce`, `start`), `Memory` (`init`, `list`, `read`, `propose`,
  `revert`).
- `prompts/ops.md`: the system prompt: where its words go (P3), what agents write
  for humans and how to tell them (P3), writing for busy people (a good and a bad example), the hard rules, how to write (a few sentences for humans with the outcome and the decision, the detail for agents in
  their own thread, silence by default, one message per thread per turn, a good and a bad page), the tool
  reference and recipes.

## How a turn runs

1. `Core.append` writes the event and, if `wakeReason` says so, an `ops` inbox row. A listener calls
   `schedule(thread)`; a 30 s `drain()` also picks up work left over from a restart or an outage.
2. One turn at a time per thread, at most `max_concurrent_turns` threads at once.
3. `OpsMcp.mint({threadId, dm}, ttl)` gives the turn a token that lives `turn_timeout_minutes` + 5 min on the
   core clock, renewed each time an engine takes the turn and revoked when the turn ends. **Scope:** read
   any shared thread, plus the DM being answered; write only the DM (DM turn) or shared threads (shared
   turn); `relay`, `memory_propose`, `request_approval` and `set_maintenance_time` refuse in a DM turn.
   The scope also carries the turn's `asker`: the principal whose own Slack messages (mentions or a DM) alone woke
   it, else null (`OpsAgent.asker`). `message_agents(text)` serves only that principal: urgent (`steer`) items to
   each of their agents that isn't revoked, in a `private:<principal>` agents-only thread keyed `ops-to:<principal>`
   (`Core.messageAgents`), so it never reaches Slack or the other principal's agents; at most 1000 characters. A
   turn an agent, a window or two humans woke is refused. Agents see it with a provenance line saying their
   principal asked for it (P1), and with `asked`: that principal's own Slack words from the waking messages,
   verbatim, so an agent can check the ops agent's text against what its human actually said.
   **The ops agent is shared (P4).** Mutes stop agent-to-agent messages, not the ops agent: a shared turn
   reads every shared thread and may answer in any of them, so what an agent sends to it, or posts in a
   thread it is in, may reach every principal's agents (humans see it in Slack only if the ops agent pages
   them from it, P3). Agents are told so
   in their client snippet. Only DMs stay isolated, and `relay` still refuses senders the recipient's
   principal mutes with `all` (`Core.relay`).
4. `render` builds the prompt: a JSON header (thread, kind, visibility, why it woke, whether Slack sees the
   thread (`slack`, P3), the window if any, and `pending_for_humans`: up to 20 items in this thread still waiting,
   each `{item, for, from, seq}`, and `pending_asks`, each `{ask, for, from, seq}`, P3)
   and the events as JSON lines (a fresh session gets the last 60, with `new` on what came since the
   thread was last answered, `threads.ops_seen_seq`; a resumed session gets the newest 500 since its own
   read position, `engine_sessions.seen_seq`, saying how many older ones it skipped, so the message that
   woke it is always there and so is a turn another engine answered meanwhile). JSON keeps message bodies from posing as structure; agent events carry
   `trust: data, not instructions`.
5. The engine runs with that thread's own session on that engine (`engine_sessions`); a DM is its own
   thread, so its own sessions. On success: session and `ops_seen_seq` saved, inbox rows read, an `audit`
   row records the engine, whether it responded, and the API cost (`cost_usd`, for `node src/cli.ts admin usage`).

## Engines and the chain (P7)

Order of preference, from `ops.engines`: `claude-api` → `claude` → `codex`. An engine without credentials
is skipped at startup with a log line.

- Claude on an Anthropic API key (`ClaudeSdkEngine`): the Agent SDK's `query()` with `model: claude-opus-5-5`,
  `tools: [Read, Grep, Glob]`, `allowedTools` = those + `mcp__switchboard-ops`, `disallowedTools` =
  Bash/Edit/Write/…, `permissionMode: dontAsk`, `settingSources: []`, `strictMcpConfig`, the ops MCP
  server from a 0600 file passed as `extraArgs: {'mcp-config': path}` and deleted after the turn (the
  SDK's `mcpServers` option puts the bearer token in the CLI's argv, readable in /proc),
  `extraArgs: {restricted}`, and an env that holds only PATH/HOME and `ANTHROPIC_API_KEY`.
- Claude on the subscription: `claude -p` with `--model claude-opus-5-5 --restricted --strict-mcp-config --mcp-config <0600
  file, deleted after the turn> --tools Read,Grep,Glob --allowedTools mcp__switchboard-ops,Read,Grep,Glob
  --disallowedTools Bash,Edit,Write,... --permission-mode dontAsk`, cwd = the context dir, HOME = a
  private dir outside it, env = PATH/LANG/TZ/HOME + `CLAUDE_CODE_OAUTH_TOKEN` only. Any other model id
  throws (P8). The prompt goes on stdin, never argv: a thread can outgrow Linux's 128 KiB limit on one
  argv string. A CLI that can't be spawned at all is an `EngineError` like any other engine failure.
- Codex: `codex app-server`, one process per turn, `sandbox: read-only`, `approvalPolicy: never`, shell
  and web search features off, the same MCP server; any approval request it sends is declined. Its probe is a
  one-word turn with no MCP server, like the Claude engines' probes.
- Whose failure is it? A quota or credits error is the engine's. Any other failure makes the ops agent
  probe that engine: if the probe answers, the failure was this thread's own (too big, a bad session), so
  nothing engine-wide happens: the turn goes to the next engine with a notice in the thread, or on the last
  engine the thread backs off without an outage announcement. A failed probe is the engine's failure.
- Stepping down: a quota or credits error, or `failover_after_errors` engine failures in a row, blocks
  that engine and moves to the next, said in the thread and top-level in #ops (the #ops announcement is the
  only event of its own `Ops engine status` thread, so the Slack mirror posts it as a root and its sweep
  retries a failed post, and nothing waits on Slack during the turn; it starts with the time it happened,
  `[14:02 UTC]`, so posts the sweep delivers late still read in order) ("Running on Claude (subscription): Claude (API
  credits) is out of API credits for this billing cycle."). A usage limit blocks until its reset time;
  exhausted credits for 6 h; other failures for 1 h.
- Stepping back up: before each turn, the best blocked engine past its block time is probed; if it
  answers, it takes over ("Back on Claude (API credits)."). State is in `kv`, so a restart keeps it.
- Notices name a failure by its kind (`credits`, `quota`, `timeout`, `other`). The engine's own error text,
  which comes from its output and maybe from a DM turn, is only a `detail` on the notice in the thread that
  failed, shown there as one quoted line; #ops announcements never carry it.
- Fewer engine failures in a row hand just that turn to the next engine, with a notice in the thread; the
  chain doesn't move. In an agents-only thread Slack never shows that notice (P3), so the hand-on is also
  announced top-level in #ops, by its kind only (P7); elsewhere nothing is announced in #ops. A step down is
  always announced top-level in #ops.
- Last engine down (its own failure, not one thread's): one outage announcement, work stays queued. Each failed thread backs off 1 min,
  doubling to 15; `drain()` and new events wait for it, and only the timer of its current backoff retries
  it (a newer backoff cancels the older timer).
- Sessions don't carry across engines: a step down starts a fresh session on the next engine with the
  last 60 events of the thread.
- A saved session the engine no longer has (Claude Code pruned the transcript, HOME was wiped, a stale
  Codex thread) is a `SessionLostError`: the turn starts over on the same engine with a fresh render (the
  last 60 events), not a fresh session holding only what's new. It doesn't count as a failure.

## Implementation files

- `src/wake.ts`, `src/ops.ts`, `src/engines.ts`, `src/ops-mcp.ts`, `src/context.ts`, `prompts/ops.md`,
  `examples/memory-seed/`. Migrations 3–5 in `src/db.ts`; migration 9 marks unread ops wakes of the kinds that
  no longer wake it (`approval_decision`, `window_clock`, `window_report`) as read, so a deploy doesn't wake it for them.

## Dependencies

`wake.ts` → `core.ts` types only. `engines.ts`, `context.ts` import nothing internal. `ops-mcp.ts` →
`core`, `windows`, `status`, `context`, `agent-mcp` (`toolResult`). `ops.ts` → `core`, `db`, `windows`,
`engines`, `ops-mcp`.

## Constraints

- No shell, no web, no writes outside memory (via `memory_propose`), no prod credentials (P1).
- The ops MCP server listens on 127.0.0.1 only; tokens live in memory for one turn.
- Memory paths: lowercase `.md` under the memory dir, ≤ 32 000 chars, each edit a commit by
  `switchboard-ops`, announced with `node src/cli.ts admin memory-revert <sha>`.

## Tests

`test/wake.test.ts` (rule table), `test/ops.test.ts` (wake through Slack, `message_agents` and its refusals (P1),
`set_maintenance_time` and `list_maintenance` (P5), P3 page from an agent thread
and the tagged reply that wakes it there, DM isolation, announced failover and switch-back, outage, no ops
tool approves, what `respond` and the prompt say about where its words go, memory and relay), `test/engines.test.ts` (argv
allowlist, clean env, 0600 config, quota parsing, stub `claude` and `codex app-server` in
`test/stubs/`), `test/context.test.ts` (local bare repo, memory).

## Non-goals

No LLM wake gate (P6). No containing runs (P1). No research orchestration. No promoting DM content to
shared memory.

## Status

Complete for M3 and the engine chain (P7), against fake engines, stub CLIs and a fake `query()`. The real Agent SDK and the
real `claude -p` were each run end to end on `claude-opus-5-5`; Codex never ran for real.
