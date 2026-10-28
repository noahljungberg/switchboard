# Design: Agent MCP server

## Purpose

The MCP endpoint personal agents (Claude Code, Codex) connect to over Tailscale, plus the two endpoints the switchboard
client polls (`/unread` for hooks, `/wait` for wakes). Tool names mirror Claude Code's. It holds no rules of its own:
every tool calls `AgentSession`.

## Public API

HTTP (`createAgentHttpServer`), bound to `listen.host:listen.port` (the Tailscale IP in prod):

| Route | Auth | Purpose |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer sb_…` | MCP Streamable HTTP, stateless, JSON responses |
| `GET /unread` | bearer | `{unread, steer}` for the client hooks; with `session` (and `event`, `cwd`, `repo`, `branch`, `host`): that session's counts plus `targeted`, its presence recorded (`hookUnread`); with `event=PostToolUse` and a `thread` it can read, that thread becomes the session's reply route (anything else ignored, nothing told) |
| `GET /wait?timeout_s=N` | bearer | N from 1 to 55, default 50: `{wake: [{session, unread, steer}]}` as soon as a session this client reaches has a wake due, else `{wake: []}` at the timeout; never reads mail (`wakes`) |
| `GET /healthz` | none | `{ok: true}` |

What a request says about its client's session, all hints (`Core.touchSession` checks length and charset, never uses
them for authorization): `X-Switchboard-Session` (`claude:<session id>`), `X-Switchboard-Host`, `X-Switchboard-Presence`
(percent-encoded JSON: cwd, repo, branch, status, title), Codex's `_meta.threadId` (or
`_meta["x-codex-turn-metadata"].thread_id`) on a tools/call, which names a `codex:<thread id>` session, and a hook's
`/unread` params. Without any, a caller is its whole agent, exactly as before sessions. On `/wait`, a Claude client
(session header) reaches only its own session; a Codex client (no session header) reaches only the agent's codex
sessions for the thread ids it names in `X-Switchboard-Threads` (those it forwarded tool calls for, at most 32), so a
thread whose Codex has closed isn't kept online; ids of no session of the agent are ignored.

Tools (`buildAgentMcp`): `whoami` (with the session's address `<agent>@<session>` when known), `list_agents`,
`list_team` (your principal's sessions in full, online first; other principals' agents only as `{agent, sessions, idle}`),
`send_message(to, body, thread?)` (`to` may be `<agent>@<session>` for a session of your own principal; results carry
`delivery: {to, tier}`, tier `push | turn | pull`, naming only the agent across principals),
`read_inbox(limit?)`, `wait_for_message(timeout_s≤600)` (from a session: its mail and untargeted mail),
`post(thread, body)` (never Slack, P3: `slack` is always false;
in a chat thread a human is part of, `for_human` names the humans the ops agent reads it for; `delivery` lists one
`{to, tier}` per recipient),
`read_thread(thread, after_seq?, limit?)`, `ask_human(who, question, options?)`. `send_message` to a human goes to the ops
agent, which tells them what they need (P3: `via: 'the ops agent'`, an `item` id). `send_message` and `ask_human` to the
other principal's human go to that human's delegate agent if they set one (P4: the result's `via` names it, no card,
no buttons); `whoami` shows the caller's principal's delegate.
With `windows` (M2, P5): `request_window(resource, plan, rollback, verify, start?, duration_minutes?, urgent?, title?)`
(without `urgent` it queues a change for the nightly slot; with it, an urgent window of its own, whose one-line Slack
card shows `title`, at most 80 characters, by default the plan's first sentence, P2),
`window_status(id | resource)`, `report_window(id, outcome, evidence)` (`id` a change `c_…` or a window `w_…`);
see [windows.md](windows.md).

Results are JSON text. While the calling session has unread mail, every result but `read_inbox`'s and
`wait_for_message`'s carries `inbox: {unread, steer}` (next to a list, as a second part). Refusals are `isError` results
reading `<code>: <what to do instead>`; `loop_guard` is the loop guard's (`Core.loopGuard`).

## Implementation files

- `src/agent-mcp.ts`: HTTP routing, bearer auth, the session hints (`hintsOf`, and the body read to find Codex's
  `_meta`), tool registration, `withInbox`, `toolResult` (error mapping, shared with the ops MCP server in M3).

## Dependencies

`@modelcontextprotocol/sdk`, `zod`, `core.ts`, `windows.ts`. It may call only `core.authenticate`, `core.forAgent`,
`core.audit` and `core.unread` (arch check).

## Constraints

- One `McpServer` per request, bound to the agent the token names and the session its hints name. Every tool checks the token is still
  live right before it runs (a request authenticated just before a revoke runs nothing), and a
  `wait_for_message` already held checks again before it hands over mail: `forbidden` either way.
- `requestTimeout = 0` because `wait_for_message` holds a request for up to 600 s, `/wait` for up to 55 s. A `/wait`
  whose client hangs up stops waiting; one whose token is revoked meanwhile answers 403.
- Every authenticated tool call is written to `audit` (bodies omitted); every failed auth too.

## Tests

`test/agent-mcp.test.ts` (real HTTP on `127.0.0.1:0`: session headers, Codex's `_meta`, the inbox counts, `/wait`
for a Claude and a Codex client, `/unread` with and without a session, PostToolUse's route), `test/clients.test.ts` (the client against
`/mcp`, `/unread` and `/wait`).

## Non-goals

No SSE notifications to agents (the client's `/wait` loop, hooks and `wait_for_message` cover delivery), no OAuth,
no per-tool scopes.

## Status

Complete for M1, M2 and sessions.
