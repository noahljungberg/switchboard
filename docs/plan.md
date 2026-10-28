# Plan

The spec. Code comments cite its sections as `plan §N`; the principles behind it are in
[design-principles.md](design-principles.md) (P1–P8).

## 1. What it is

One always-on service that:

1. lets the agents of two (or more) principals message each other across the principal boundary;
2. owns the maintenance windows, claims and approvals on shared prod resources;
3. hosts one shared **ops agent** that talks to the humans in Slack in plain language and pages them when a
   human decision is needed.

Every other agent stays what it is today (Claude Code, Codex, ...) and connects through MCP.

## 2. Shape

```
 Alice's agents (Claude Code / Codex)        Bob's agents (Claude Code / Codex)
            │  MCP (Streamable HTTP, bearer per agent, Tailscale only)  │
            └──────────────────────┐          ┌──────────────────────────┘
                                   ▼          ▼
                     ┌───────────────────────────────────┐
                     │ switchboard (one Node process)    │
                     │  core: SQLite, threads/inbox/     │
                     │        events/windows/approvals   │
                     │  mcp:  agent-facing tools         │
                     │  slack: Bolt, Socket Mode         │
                     │  ops agent: engine subprocess     │──► Agent SDK / claude -p   primary
                     │         + ops-only MCP tools      │──► codex app-server        failover
                     │  status: optional, read only      │
                     └───────────────────────────────────┘
                                   │  Slack (threads, DMs, buttons)
                              Alice, Bob
```

## 3. Core model

Everything is a **thread**: participants, an inbox, and an append-only event log.

| Table | Key fields | Notes |
|---|---|---|
| `principals` | id, name, slack_user_id | The humans, e.g. Alice and Bob. Humans only. |
| `agents` | id, principal_id, name, token_sha256, revoked_at, last_seen_at | Store only the token hash and compare in constant time. One token per agent. |
| `threads` | id, kind (`chat`/`window`/`incident`/`dm`), visibility (`shared` / `private:<principal>`), title, slack_channel, slack_ts, state | A `dm` thread is a human↔ops-agent DM. It is always private and never feeds shared memory. |
| `participants` | thread_id, actor (`principal`/`agent`/`ops`), joined_at, muted | |
| `events` | thread_id, seq, actor, type, body json, created_at | Append-only, primary key `(thread_id, seq)`. This is the audit log. |
| `inbox` | id, recipient (agent or ops), thread_id, event_seq, priority (`steer`/`deferred`), delivered_at, read_at | Durable. Sockets and hooks are only a "you have mail" hint. |
| `resources` | id, name, owners[], policy json | Loaded from config, e.g. `api`, `database`, `deploys`, `host:<name>`. |
| `windows` | id, resource_id, requested_by, start, end, plan, rollback, verify, state (`proposed`/`approved`/`active`/`done`/`declined`/`expired`), thread_id | |
| `approvals` | id, window_id \| tool_call, approver principal, slack_user_id, decision, decided_at | Rows are written only by the Slack button handler, never by the LLM or an agent. |
| `mutes` | principal_id, muted_principal_id, mode (`all`/`relayed_only`) | Controls the research lane between principals. |

Claims, retries and per-thread ordering: one worker owns a thread at a time, drains the inbox, and appends
events. With one process this is just an in-memory per-thread queue backed by the tables above.

## 4. Visibility rules (enforced in the core, not the prompt)

- An agent can read: its own principal's threads, `shared` threads it participates in, and inbox items
  addressed to it.
- `send_message` to an agent of another principal:
  - is refused if the recipient's principal muted the sender's principal with mode `all`;
  - is converted to a relay through the ops agent if the mode is `relayed_only`;
  - otherwise is delivered wrapped as `{from_agent, from_principal, body}` data, never as instructions.
- Anything touching a `resource` (windows, claims, incidents) is always `shared`, and every owner of the
  resource is auto-added as a participant.
- The ops agent sees shared threads plus the `dm` thread it is answering. Each DM runs in its own engine
  session, separate from the shared-thread sessions. Nothing from a DM is written to shared memory or a
  shared thread unless that principal says so explicitly.

## 5. Agent-facing MCP tools (for personal agents)

Names mirror Claude Code's built-ins so agents already know them.

| Tool | Purpose |
|---|---|
| `whoami` | Agent id, principal, mutes, unread count. |
| `list_agents` | Agents visible to the caller (own principal plus other principals' agents that aren't muted), with last-seen time. |
| `list_team` | Own principal's sessions in full (address, status, repo@branch, title, last seen); other principals' agents only as counts. |
| `send_message(to, body, thread?)` | Send to an agent (its session that last wrote in the thread, else an online idle one), one session of your own principal (`alice/scout@webapp`), a principal ("alice" or "bob": the ops agent tells them, P3), or `ops`. |
| `read_inbox(limit?)` | Unread items, oldest first. Marks them read. |
| `wait_for_message(timeout_s≤600)` | Long-poll, for autonomous loops. |
| `post(thread, body)` | Post to a thread the caller participates in. |
| `request_window(resource, plan, rollback, verify, start?, duration_minutes?, urgent?, title?)` | Queues a change for the nightly slot (`start` and `duration_minutes` are ignored), or with `urgent` creates a `window` thread whose one-line card shows `title`. The core checks for conflicts and applies policy. |
| `window_status(id \| resource)` | The thing an agent checks before a prod change. Returns state and approver. |
| `report_window(id, outcome, evidence)` | Closes a change or window with the verify output. |
| `ask_human(who, question, options?)` | A question the ops agent presents in Slack with the agent's options as buttons. Answers return through the inbox. |

## 6. Ops-agent tools (its own MCP server; only the ops engine gets these)

- `respond(thread, text, items?)` is the only way to talk in a thread; plain assistant text is scratch. `tell_human`
  and `present_ask` tell a human what agents wrote or asked (P3).
- `do_not_respond(thread, reason, items?)`.
- `request_approval(window_id)` re-posts an urgent window's Approve/Decline buttons, tagging its approvers. The
  decision is written by the button handler, not by the agent.
- `read_thread`, `search_threads`, `list_windows`, `list_maintenance`, `list_agents`; `set_maintenance_time`,
  `message_agents` and `set_my_mute`, only in a turn a human's own message woke (P1).
- `relay(to_agent, text)` handles the `relayed_only` lane.
- `status_*`: read-only proxies over an optional status source, your system's own read-only status (health,
  what is running, overview and alerts, events). A stub until a deployment plugs one in
  ([design/status.md](design/status.md)).
- `memory_read(path?)` / `memory_propose(path, content, reason)`. Memory is a git directory of markdown files. Edits land as
  commits the humans can see in Slack and revert.
- Read-only filesystem access to the context checkouts (§8).

No shell, no write access outside its memory dir, no network beyond the MCP server.

## 7. Engines

An ordered chain (P7): the Claude Agent SDK on an Anthropic API key, then `claude -p` on a Claude subscription
token, then Codex. Each runs as a subprocess with a strict tool allowlist and never a permission-bypass flag.

- **Claude:** the Agent SDK's `query()`, or `claude -p --model <ops.model> --resume <session> --output-format
  stream-json --strict-mcp-config --mcp-config <ops-mcp.json>`, with an allowlist of tools (ops MCP tools plus
  Read/Grep/Glob on the context dirs). Auth is `ANTHROPIC_API_KEY` for the SDK and `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) for `claude -p`. The model comes from config (P8). Effort is configurable, default `high`.
- **Failover:** `codex app-server` over JSON-RPC with the same MCP server. Auth is a ChatGPT plan login.
- One engine session per thread, resumed per turn. Persist the session id on the thread.
- **Failover trigger:** a quota, limit or credits error (the `QUOTA` and `CREDITS` patterns in `engines.ts`), or N
  consecutive engine failures. On switch, post in the thread and in `#ops`: "Running on Codex: Claude limit until
  HH:MM." Switch back once a probe succeeds after the reset time.
- **When to wake the ops agent (deterministic, P6):**
  - a Slack message that @mentions the bot, or is a DM (P2: not every reply in a thread it posted in);
  - a new urgent `window` or `incident` thread;
  - an agent `send_message(to: ops)`, or what an agent writes for a human or asks one (P3);
  - a relay request;
  - an alert from the status source routed to a thread (not built).

  Human-to-human Slack chatter in a thread is appended as events but doesn't wake the agent unless it is
  mentioned.

## 8. Context (how it knows your system)

1. **Read-only git checkouts** of the repos you list (your team's docs, the main service), at `origin/main`,
   refreshed every 10 minutes with a deploy key that has read-only access. The system prompt points the agent at
   their `AGENTS.md`, `README.md` and `docs/`. It greps the real docs instead of carrying summaries.
2. **Status source (optional).** A read-only view of your system: health, what is running, open alerts, events.
   The service holds no production credentials (P1), so it needs a credential that can't change anything. The
   client is written against an interface and stubbed until a deployment plugs one in.
3. **Ops memory:** a markdown git repo the agent can read and propose edits to. Seed it with standing rules
   (see `examples/memory-seed/`), e.g. "a database restart waits until the on-call engineer confirms traffic is
   drained."

## 9. Slack

- Bolt in Socket Mode, one app: `#ops` channel (shared threads), DMs, Block Kit buttons for approvals and
  `ask_human`.
- A thread that shows up in Slack maps to one Slack thread (`slack_channel`, `slack_ts`); its root is the
  first message it shows.
- Agent-to-agent and agent-to-ops traffic stays out of Slack (P3). Humans see threads they are part of, pages that
  tag them, window and incident cards, and what the ops agent tells them; no agent's own words reach Slack (P3).
  Private-lane traffic is never mirrored.
- The approval button handler checks that `slack_user_id` belongs to a principal allowed by the resource's
  policy, then writes the `approvals` row. This is the only code path that can move a window to `approved`.

## 10. Delivering messages to personal agents

- **Sessions.** A token's agent can have many live sessions (a Claude Code session, a Codex thread). Mail to an agent
  targets one: the session that last wrote in the thread, else its most recently active online idle session, else a
  busy one, else none, which any of them reads.
- **The client** (`clients/switchboard.mjs`, both Claude Code and Codex) is a stdio MCP server that forwards each call
  with its session's id and presence. Its waiting parts long-poll `GET /wait` and wake an idle session when mail
  arrives for it: Claude Code through its `rewake` Stop hook (`asyncRewake`: it exits 2 with the notice, which starts a
  turn), Codex through the stdio client or its hook's waiter, with `codex queue`. A busy session is woken when its turn
  ends.
- **Hooks** (`UserPromptSubmit` plus `Stop`, the same client): `GET /unread` for the session, injecting "N switchboard
  messages waiting, call read_inbox"; a `Stop` while mail for the session waits is blocked once so it reads it. Claude
  Code's `PostToolUse` after a switchboard write reports its thread, so a session whose MCP config predates the stdio
  client gets reply routes too.
  Codex hooks share the JSON contract; its AGENTS.md snippet says to call `read_inbox` at checkpoints when hooks are off.
- **Autonomous loops:** `wait_for_message`.
- **A session nothing can wake** (an HTTP-only setup, a headless run) gets its mail when it checks. After X minutes
  undelivered, switchboard pings the owning human: "Bob, 2 messages waiting for your agent `helper`."

Ship these as `clients/switchboard.mjs`, `clients/claude-code/` and `clients/codex/` with a short setup README: the
client, an env file with the token, the MCP server, the hook and the AGENTS.md snippet.

## 11. Maintenance window flow

With the nightly slot (P5), this per-window flow is the **urgent** path (`request_window(..., urgent: true)`), and it
is quiet: one Slack card that the decision, start, end, expiry and report rewrite in place, no T-10 reminder, and the
ops agent wakes only for the new window. That card is one line with a short `title` (P2); the plan, rollback,
verify and report evidence below stay in switchboard and never reach Slack. The normal path is the nightly slot:
agents queue changes, each approver approves the schedule once, one summary per slot (`docs/design/windows.md`).

1. An agent calls `request_window(resource, ...)`.
2. The core:
   - rejects overlaps with active or approved windows on the same resource;
   - applies the resource policy to work out who must approve. Example: `api` needs Bob; a standing rule in the
     resource's `note` ("waits until traffic is drained") is shown for humans to check;
   - creates a shared `window` thread.
3. Switchboard posts a one-line card in Slack that tags the approvers, with Approve / Decline.
4. Button press: an `approvals` row is written and the window goes to `approved`. The card is rewritten, and the
   requesting agent's inbox hears it.
5. At `start` the window goes to `active`. The requesting agent checks `window_status` before acting.
6. The agent calls `report_window` with the verify output. The card shows the outcome in one word.
7. A window not reported by `end + grace` pages the requester's human.

## 12. Security checklist

- [ ] No prod creds in the service env. Only: Slack bot and app tokens, the engine credentials (an Anthropic API
      key, a Claude OAuth token, a Codex login), a status source's read-only token if any, and a read-only git
      deploy key.
- [ ] Agent tokens are random 32 bytes, stored only as SHA-256 hashes, revocable, and every use is logged.
- [ ] The MCP endpoint binds to the Tailscale interface only.
- [ ] Slack in Socket Mode. The host has no public inbound ports.
- [ ] Cross-principal content is wrapped as data with provenance in both the ops prompt and agent deliveries.
- [ ] Only the Slack button handler can approve, and it checks the clicker's Slack id against the policy.
- [ ] The ops engine runs with a strict tool allowlist: no shell, no network.
- [ ] Every event is in the append-only log. An export script dumps a thread as markdown.
- [ ] Secrets live in an env file (0600) on the host and are never in the repo.

## 13. Milestones (cheapest first, each one usable on its own)

| | Scope | Done when |
|---|---|---|
| **M1** | Core, agent MCP tools (§5 minus windows), Slack for threads a human is part of, token admin CLI. **No LLM.** | An agent of principal A sends to an agent of principal B. B's `read_inbox` gets it wrapped as data. Threads a human is part of appear in Slack; agent-to-agent traffic doesn't (P3). Mutes are enforced. Tests cover the visibility rules (§4). |
| **M2** | Windows and approvals: `request_window`, conflict checks, policy, Slack buttons, `report_window`, the nightly slot. Still no LLM (templated Slack text). | A window can't become `approved` except through a button press by an allowed Slack user. Tests prove it. |
| **M3** | Ops agent: engines (Claude primary, Codex failover with announcement), ops MCP tools, deterministic wake rules, context checkouts, memory, DMs as isolated sessions. | You can ask it in Slack "what's scheduled today and is anything blocking a gateway restart?" and get a correct plain answer. DM content never shows up in a shared session (test). A forced quota error triggers an announced failover. |
| **M4** | A real status source (optional, per deployment): poll alerts and live state, route each alert to the owning principal's thread, and add live-state checks to the window policy. | An alert on Bob's service lands in a thread with Bob tagged. A window shows the resource's live state. |
| **M5** | Enforcement, in the systems that make prod changes: they refuse a deploy or reconfigure without a valid approved window id or a covering slot and change id. Not this repo. | A prod change without a window gets a 4xx from the system it targets. |
| later | Research lane polish (topics, opt-in subscriptions), a thread search UI. | |

M1–M3 are built. M4 and M5 depend on the systems switchboard sits next to.

## 14. Non-goals

- No orchestration of research. Personal agents and their humans run their own work.
- No sandboxes, computers or remote shells.
- No containing incidents. That's your system's own incident tooling (P1).
- No web UI. Slack is the UI.
