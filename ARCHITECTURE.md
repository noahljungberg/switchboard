# Architecture

One Node ≥ 24 process, TypeScript run directly (type stripping, no build step), SQLite via `node:sqlite`.
The spec is [`docs/plan.md`](docs/plan.md); this file is the code's shape and the rules that keep it.

## The one idea

**Deterministic core, LLM on top (P6).** Threads, the event log, the inbox, mutes, windows and approvals
are rows that plain code checks. Slack, the agent MCP server and the ops agent are surfaces over that core.
None of them can widen what the core allows. The ops agent is the voice, never the authority.

## Layers

Lower layers never import higher ones. `npm run check:arch` enforces the table below (the `LAYERS` map in
[`scripts/check-arch.ts`](scripts/check-arch.ts)); a new file must be added to both.

| Layer | Files | May import |
|---|---|---|
| 0 Foundation | `config.ts`, `db.ts` | nothing internal |
| 1 Core (trust boundary) | `core.ts`, `windows.ts`, `wake.ts` | layer 0, and each other downward (`windows` → `core`) |
| 2 Adapters (thin interfaces) | `slack.ts` (SlackPort + Bolt), `engines.ts` (Engine + claude/codex), `status.ts` (StatusSource + stub), `context.ts` (checkouts + memory) | layer 1 only; `engines`, `status`, `context` import nothing internal |
| 2 Surfaces | `agent-mcp.ts` (personal agents' MCP); `ops-mcp.ts` (ops engine's MCP, loopback) | layer 1, layer-2 adapters they serve |
| 3 Ops agent | `ops.ts` | layers 0–2 |
| 4 Entry | `main.ts` (wiring), `cli.ts` (`serve` + `admin`) | anything; nothing imports them except `cli.ts` → `main.ts` |

```
 personal agents ──MCP/HTTP──► agent-mcp ─┐
 Slack (Socket Mode) ◄──────► slack ──────┤
 ops engine (claude / codex) ─MCP──► ops-mcp ─┤──► core / windows ──► db (SQLite)
                              ops (wake queue, failover) ─┘        ▲
                              engines, context, status ────────────┘ (adapters, no core imports)
```

## Where the trust boundary is enforced

| Rule (plan) | Enforced by | Test |
|---|---|---|
| Visibility §4 | `AgentSession` in `core.ts` (every agent tool goes through it); `agent-mcp.ts` may only call `core.forAgent/authenticate/audit/unread` (arch check) | `test/core.test.ts` |
| Mutes and relays §4; a reply gets past a mute only from the agent the muting side's agent wrote to in that thread, after the mute was last set and within 24 h (P4) | `Core.fanOut`, `Core.solicited`, `AgentSession.sendMessage`, `Core.relay` (needs a pending request) | `test/core.test.ts` "solicited replies (P4)" |
| What another principal's agents address to a human with a delegate goes to that delegate's inbox, never Slack, past any mute; only a live agent of that principal can be named (P4) | `AgentSession.toDelegate`, `Core.delegate`, `Core.setDelegate` (callable only from `cli.ts`, arch check); triggers on `principals` (migration 11) | `test/core.test.ts` "delegates (P4)", `test/slack.test.ts` "P4: …" |
| Messages are data (P4) | Inbox items are `{from_agent, from_principal, body}` + provenance note; agents never steer another principal's agents | `test/core.test.ts` |
| Tokens §12 | SHA-256 only, constant-time compare, rotate/revoke, every tool call audited | `test/core.test.ts`, `test/agent-mcp.test.ts` |
| Sessions are hints: what a client says (session key, host, presence, Codex's `_meta.threadId`, a hook's params) only picks one of the token's own agent's sessions, checked for length and charset; another principal's sessions can't be addressed, `list_team` shows them as counts, `delivery` names only the agent | `Core.touchSession`, `AgentSession.sessionOf`, `listTeam`, `Core.delivery`; `UNIQUE (agent_id, key)` on `sessions` (migration 15) | `test/core.test.ts` "sessions", "addressing and delivery", "list_team" |
| A message wakes a session at most once, never untargeted mail or a busy session; the wake notice carries only counts | `Core.claimWake` (one INSERT into `inbox_told`, per message and session), `AgentSession.wakes`; `clients/switchboard.mjs` builds the notice | `test/agent-mcp.test.ts` "GET /wait…", `test/clients.test.ts` |
| Loop guard: agents' own messages capped per sender and recipient and per agent; humans, switchboard and the ops agent never | `Core.loopGuard` in `AgentSession.guarded` | `test/core.test.ts` "loop guard" |
| Append-only log §12 | SQLite triggers on `events` | `test/core.test.ts` |
| Window/incident threads always shared, DMs always private | `CHECK` constraints on `threads` | `test/core.test.ts` |
| Slack cards are one line, capped at 300 characters; plans, rollbacks, verify steps and report evidence are never rendered (P2) | `card()` (`CARD_MAX`) and the card renderers in `slack.ts`; the slot summary's own budget in `windows.ts` | `test/slack.test.ts` "absurdly long plans, titles, evidence, resource names and notes…" |
| No agent's text ever reaches Slack: what agents write for humans goes to the ops agent as items, which only a turn that can write their thread handles (P3) | `SlackBridge.render` (agent messages and `ask_human` render nothing; a question shows only as the ops agent's `ask_presented` card with the agent's own options), `AgentSession.forHuman`, `post` and `askHuman`, `human_items` and `asks` (migrations 13, 14), `tell_human` / `present_ask` / `respond` / `do_not_respond` in `ops-mcp.ts` (`OpsMcp.items`, `askable`); `Core.presentAsk`, `skipAsk` and `handleHumanItems` callable only from `ops-mcp.ts` (arch check) | `test/slack.test.ts` "P3: no agent-authored text…", `test/ops.test.ts` "P3: …" |
| Ops text can't pass for a system card (P1, P2) | system cards carry the `FOOTER` context block in `slack.ts`; ops messages are posted as plain text only | `test/slack.test.ts` "system cards carry a switchboard footer" |
| Only a Slack button approves (P1, §9) | `windows.decideFromSlackButton`, callable only from `slack.ts` (arch check), plus DB triggers on `windows`/`approvals` | `test/windows.test.ts` |
| The nightly slot is approved only by each approver's own button, per schedule version (P1, P5) | `windows.decideStandingFromSlackButton`, callable only from `slack.ts` (arch check), plus DB triggers on `standing_approvals` (own Slack user, a card posted to them, of the current version, append-only), `standing_cards` (what a card approves is fixed when posted, so config can't widen it) and `schedules` (append-only versions) | `test/windows.test.ts` "a standing approval comes only from…", `test/ops.test.ts` "no ops tool can approve…" |
| Ops engine sees shared threads + the DM it answers; a DM turn writes only to that DM | per-turn scoped token in `ops-mcp.ts` (`canSee`, `canWrite`, `sharedOnly`); one engine session per thread | `test/ops.test.ts` "DM isolation" |
| Mutes stop agent-to-agent messages; the ops agent is shared, so what reaches it may reach every principal's agents (P4); only DMs stay isolated | no filtering in `ops-mcp.ts` by design; `Core.relay` still refuses senders the recipient mutes with `all` | `test/ops.test.ts` "P4", "DM isolation" |
| The ops agent messages a principal's agents only when that principal asked, and only theirs (P1) | `asker` in the turn's scope (`OpsAgent.asker`: one principal's own Slack messages alone woke it), `message_agents` in `ops-mcp.ts`; `Core.messageAgents` callable only from `ops-mcp.ts` (arch check); a `private:<principal>` thread | `test/ops.test.ts` "P1" |
| The ops agent changes a mute only for the human whose own Slack message woke the turn, and only their own side (P1) | `set_my_mute` in `ops-mcp.ts` (the turn's `asker`, no principal argument) through `Core.setOwnMute`, which audits the human's words and posts a fixed notice in their DM on every change; `Core.setOwnMute` callable only from `ops-mcp.ts`, `Core.setMute` only from `cli.ts` and the e2e script (arch check) | `test/ops.test.ts` "set_my_mute …" |
| Only a human's own #ops message can get the ops agent to move the nightly slot, which voids every standing approval (P5) | `set_maintenance_time` in `ops-mcp.ts` needs a shared turn with an `asker`; `Windows.setSchedule` callable only from `ops-mcp.ts` (arch check) | `test/ops.test.ts` "set_maintenance_time moves the nightly slot only in…" |
| The ops agent can't approve (P1) | no such tool; `request_approval` only re-posts buttons | `test/ops.test.ts` "no ops tool can approve" (fails if a new tool isn't covered) |
| Ops engine: only the configured model, no shell/web/writes (P8) | `claudeSdkOptions` and `claudeArgs` allowlists + model guards in `engines.ts`; Codex read-only sandbox; engine env stripped of service secrets; arch check bans bypass flags and other model ids | `test/engines.test.ts` |
| Wake is deterministic (P6) | `wake.ts`, called inside `Core.append` (same transaction as the event) | `test/wake.test.ts`, `test/ops.test.ts` |
| Engine chain API credits → subscription → Codex, every step announced (P7) | `OpsAgent.withEngine` / `maybeSwitchBack` → notice in thread + top-level #ops | `test/ops.test.ts` "failover" |

## Data flow of one message

1. An agent calls `send_message` → `agent-mcp.ts` → `AgentSession.sendMessage` (as the session its client named)
   checks mutes and the loop guard, and picks or creates the thread.
2. `Core.append` writes the event and its inbox rows in one transaction (`db.tx`), each targeting one of its agent's
   sessions (`Core.target`: the session that last wrote in the thread, else an online idle one), then, after commit,
   notifies listeners and held waits (`afterCommit`).
3. Listeners: the Slack mirror (`SlackBridge.sync`, per-thread serial, retried by `sweep`; it posts what the ops
   agent and the core write, never an agent's text, P3) and the ops agent (`OpsAgent.schedule`, if the append wrote
   an `ops` inbox row per `wake.ts`).
4. The recipient session's waiting client, holding `GET /wait`, gets a wake and wakes it (Claude Code: its `rewake`
   Stop hook exits 2 with the notice; Codex: `codex queue`); a busy session is woken when its turn ends, and its hooks
   hit `GET /unread`. The agent calls `read_inbox`. The inbox row is the truth; wakes, hooks and sockets are only hints
   (P6).

## Rationale for the non-obvious choices

- **No build step.** Node 24 strips types natively; `tsc` only typechecks. `erasableSyntaxOnly` keeps
  the code strippable (no enums, no parameter properties).
- **Stateless MCP over HTTP.** One `McpServer` per request, bound to the authenticated agent. No session
  state to leak between agents, and a revoked token fails on the very next call.
- **Durable mirror.** `threads.slack_synced_seq` records how far Slack has caught up, so a Slack outage
  delays the mirror instead of losing it.
- **Fakes, not mocks.** Each adapter has one real implementation and one fake in `test/fakes.ts`; core
  tests run with no network.
