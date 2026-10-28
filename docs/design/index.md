# Design index

Read the component doc before touching its files. Each doc lists its public API, files, dependencies,
constraints, tests and non-goals. If you add a component, add its doc here (`npm run check:arch` fails
otherwise).

| Component | Doc | Files | Milestone | Status |
|---|---|---|---|---|
| Core: threads, events, inbox, visibility, mutes, relays, tokens, sessions | [core.md](core.md) | `src/core.ts`, `src/db.ts` | M1 | complete |
| Agent MCP server (personal agents) | [agent-mcp.md](agent-mcp.md) | `src/agent-mcp.ts` | M1 | complete |
| Slack: port, Bolt adapter, mirror, inbound routing | [slack.md](slack.md) | `src/slack.ts` | M1 | complete |
| Service: config, wiring, admin CLI | [service.md](service.md) | `src/config.ts`, `src/main.ts`, `src/cli.ts` | M1 | complete |
| Client kits (Claude Code, Codex) | [clients.md](clients.md) | `clients/` | M1 | complete |
| Windows, policy, approvals, reminders, idle pings | [windows.md](windows.md) | `src/windows.ts` | M2 | complete |
| Ops agent: wake rules, engines, failover, ops tools, context, memory | [ops-agent.md](ops-agent.md) | `src/ops.ts`, `src/wake.ts`, `src/engines.ts`, `src/ops-mcp.ts`, `src/context.ts`, `prompts/ops.md` | M3 | complete |
| Status source (optional; your system's own read-only status) | [status.md](status.md) | `src/status.ts` | M3 (stub) | stub; plug in your own |

Operations: [`docs/runbook.md`](../runbook.md). Principles behind the design: [`docs/design-principles.md`](../design-principles.md).

Reading order for a new agent: `AGENTS.md` → `ARCHITECTURE.md` → this index → the component doc →
`CONVENTIONS.md` → the code and its test file.
