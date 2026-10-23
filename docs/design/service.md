# Design: Service (config, wiring, admin CLI)

## Purpose

Starts the process and gives operators a CLI. Config is a YAML file for shape and the environment for
secrets; the YAML never holds a secret.

## Public API

- `src/config.ts`: `loadConfig(path?)`, `parseConfig(raw)`, `loadSecrets(env)`. Schema in zod; errors
  name the bad field. `solicited_reply_hours` (default 24, P4): how long after an agent last wrote to the other side's
  agents in a thread their replies there still pass its mute. `ask_expiry_minutes` (default 60, P3): an ask the ops agent hasn't presented by then
  expires. `maintenance: {start, duration_minutes}` (default 21:00 for 120 min, P5) seeds the
  nightly slot once; the DB holds it from then on. `window_remind_minutes` is gone; a config that still sets
  it parses. See [`config.example.yaml`](../../config.example.yaml) and
  [`.env.example`](../../.env.example).
- `src/main.ts`: `start({config, secrets, slack?, engines?, status?, now?})` → `{core, windows, bridge,
  agentUrl, ops?, stop()}`. `slack` and `engines` replace Bolt and the CLIs with fakes (tests, e2e). Also
  `dbPath`, `contextDir`, `listen`.
- `src/cli.ts` (`switchboard`, bin):
  - `serve`
  - `admin add-principal <id> --name <Name> [--slack U…]`, `set-slack`, `add-agent <principal> <name>`
    (prints the first token), `issue-token <agent>` (rotate), `revoke-token <agent>`,
    `set-mute <principal> <muted> all|relayed_only|none`, `set-delegate <principal> <agent-id|none>` (P4; audited),
    `list` (each principal's delegate too), `export-thread <thread>`,
    `memory-revert <sha>`, `usage` (this month's ops turns and API-credit spend per engine), `ask-standing
    <principal>` (P5: posts their standing-approval card for the current schedule version through
    `Windows.askStanding`, unless it was already posted or approved; audited; the running service's sweep posts it),
    `rerender-cards` (P2: `Windows.rerenderCards` marks every standing card and live urgent-window card Slack shows
    with a `card_rerender` event; the running service's sweep rewrites each in place in the current format and posts
    nothing; one audit row).

## Implementation files

- `src/config.ts`, `src/main.ts`, `src/cli.ts`.

## Dependencies

Anything below. Nothing imports `main.ts` except `cli.ts` and `scripts/e2e.ts`; nothing imports `cli.ts`.

## Constraints

- Data dir is created `0700`; the DB is `<data_dir>/switchboard.db` in WAL mode, so the admin CLI and the
  service can open it at once. A revoke or mute applies on the service's next request.
- `start()` tears down what it opened (servers, timers, Bolt, DB) if any later step fails, and `serve`
  exits non-zero on a failed start, so systemd sees the failure at once instead of a half-started process.
- Tokens are printed once and never stored in plaintext.

## Tests

`test/cli.test.ts`, `scripts/e2e.ts` (the full wiring with fake Slack).

## Non-goals

No web UI (plan §14), no config hot-reload (restart the unit).

## Status

Complete for M1–M3. M2: resources in config; a 30 s tick runs `windows.tick()`, `core.pingIdleAgents()`, (P3) `core.expireAsks()` and `core.expireSessions()` (gone sessions' names and mail).
M3: the optional `ops:` section starts the context loop, the memory repo, the loopback ops MCP server and
the ops agent (`startOps`); `serve` pets the systemd watchdog; `admin memory-revert <sha>`.
