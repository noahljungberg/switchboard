# Runbook

Setting up and running switchboard on a small neutral VM (P4). Nothing here is automated from this repo: an
operator runs these steps on the host. Every principal should have admin on it, so all sides trust it equally.

Admin commands below use `sb`, the CLI run as the service user against the installed config:

```sh
alias sb='sudo -u switchboard --preserve-env=SWITCHBOARD_CONFIG node /opt/switchboard/src/cli.ts admin'
export SWITCHBOARD_CONFIG=/etc/switchboard/config.yaml
```

The service's own messages (Slack notices, error texts) name the CLI by its package bin, `switchboard admin …`: that is
the same command as `sb …` here.

## 0. Host

- Any small Linux VM (1–2 vCPU, 2 GB RAM is plenty for a few dozen agents) that no single principal owns
  outright. No public inbound ports: the firewall allows nothing inbound; SSH over Tailscale only.
- Node ≥ 24, git, `claude` (Claude Code CLI) ≥ 2.1.299 for the subscription engine, `codex` (Codex CLI) for
  the last engine. The API-key engine (`claude-api`) runs the Claude Code binary bundled with `@anthropic-ai/claude-agent-sdk`
  (pinned in `package-lock.json`), so it needs nothing extra.
- A service user: `sudo useradd --system --create-home --home-dir /var/lib/switchboard switchboard`.
- Code in `/opt/switchboard` (a checkout of this repo): `npm ci --omit=dev`.

## 1. Tailscale

1. `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh --hostname switchboard`.
2. Note the host's Tailscale IPv4 (`tailscale ip -4`). Put it in `config.yaml` as `listen.host`; the
   agent MCP endpoint binds there and nowhere else. The ops MCP server always binds 127.0.0.1.
3. In the Tailscale ACLs, allow Alice's and Bob's devices (the ones that run agents) to reach
   `switchboard:7420`, nothing else.
4. Agents use `SWITCHBOARD_URL=http://switchboard.<tailnet>.ts.net:7420`.

## 2. Slack app (Socket Mode)

Create an app from this manifest (api.slack.com/apps → Create New App → From a manifest):

```yaml
display_information:
  name: switchboard
features:
  bot_user:
    display_name: ops
    always_online: true
oauth_config:
  scopes:
    bot: [chat:write, im:history, im:write, channels:history, groups:history, users:read]
settings:
  event_subscriptions:
    bot_events: [message.channels, message.groups, message.im]
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

1. Install it to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
2. Basic Information → App-Level Tokens → generate one with `connections:write` (`xapp-…`) →
   `SLACK_APP_TOKEN`.
3. Create `#ops` (or reuse it), `/invite @ops`, and copy its channel id (channel details → bottom) into
   `config.yaml` as `slack.ops_channel`.
4. App Home → enable the Messages tab so people can DM the bot.

## 3. Anthropic API key (first engine, P7)

The first engine runs the Claude Agent SDK on an Anthropic API key, billed per token.

1. In the Claude Console (platform.claude.com), create a workspace for switchboard and an API key in it.
2. Set the workspace's monthly **spend limit** to what you're willing to pay, so a busy month can't run up the
   bill. When the limit or the credits run out, the engine steps down the chain (announced).
3. Put the key in the env file as `ANTHROPIC_API_KEY`. The engine passes it only to the SDK subprocess.
4. Check: `node scripts/smoke-engine.ts claude-api` (see §11).
5. Track spend: `sb usage` (this calendar month's turns and dollars per engine) or the Console's usage page.
   When the credits run out, the agent says so in #ops and steps down to the subscription; it probes the
   API every few hours and steps back up when it answers again.

## 4. Claude subscription token (second engine)

Give the agent a Claude subscription of its own, not someone's personal login, so it never competes with a
person's interactive use for the same usage limits (P7).

1. On any machine with a browser, logged in to **that** account: `claude setup-token`. It prints a token
   valid for one year.
2. Put it in the env file as `CLAUDE_CODE_OAUTH_TOKEN`. Don't use `--bare` anywhere: it ignores the token.
3. Check on the host as the service user:
   `sudo -u switchboard env CLAUDE_CODE_OAUTH_TOKEN=… claude -p 'Reply OK' --model claude-opus-5-5 --restricted --tools ''`.
4. Renew before it expires (calendar it). To rotate: run `claude setup-token` again, replace the env
   value, `systemctl restart switchboard`.

## 5. Codex login (third engine)

**Leave `codex` out of `ops.engines` in prod for now** (known issue K5). Its read-only sandbox can read every
file the service user can, including `switchboard.db`, which holds every principal's DMs with the ops agent
and their private threads, and the env file. Add it back once engine subprocesses run as their own unix user.

1. As the service user: `sudo -u switchboard env CODEX_HOME=/var/lib/switchboard/codex-home codex login --device-auth`
   and complete the device flow with the ChatGPT account you chose for the failover.
2. Keep `CODEX_HOME=/var/lib/switchboard/codex-home` in the env file.
3. Check: `sudo -u switchboard env CODEX_HOME=… codex exec 'Reply OK'`.
4. To drop an engine, remove it from `ops.engines` in `config.yaml`. Every step down the chain is announced
   in Slack (P7); if the last engine fails too, the agent announces an outage and queues work.

## 6. Context repos

1. Create a key pair: `ssh-keygen -t ed25519 -N '' -f /etc/switchboard/deploy_key -C switchboard`.
2. Add the public key as a **read-only** deploy key on each repo the agent should read, such as your team's docs
   and your main service (GitHub → repo → Settings → Deploy keys; leave "Allow write access" off).
3. `chown switchboard: /etc/switchboard/deploy_key && chmod 0400 /etc/switchboard/deploy_key`;
   `CONTEXT_DEPLOY_KEY_PATH=/etc/switchboard/deploy_key` in the env file.
4. List the repos under `ops.context.repos`. They refresh every `refresh_minutes` with a shallow fetch
   and hard reset; errors are logged and the last good checkout stays.

## 7. Config and secrets

```sh
sudo install -d -o switchboard -m 0700 /etc/switchboard
sudo install -o switchboard -m 0600 config.example.yaml /etc/switchboard/config.yaml   # then edit
sudo install -o switchboard -m 0600 .env.example /etc/switchboard/env                   # then fill in
```

The env file holds every secret; `config.yaml` holds none. Keep your real `config.yaml` (resources, principals'
rules) wherever you keep other deployment config, outside this repo.

`ops.memory_seed_dir` seeds the ops memory once, the first time the service starts. A relative path is
resolved from the config file's directory, so the example's `examples/memory-seed` would point at
`/etc/switchboard/examples/memory-seed`: set it to the checkout's, `/opt/switchboard/examples/memory-seed` (or your own
seed). If the path doesn't exist, the service refuses to start and names it. List the repos the agent should read
under `ops.context.repos` (§6); the example leaves it empty.

## 8. systemd unit with a watchdog

`/etc/systemd/system/switchboard.service`:

```ini
[Unit]
Description=switchboard
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=60
Restart=always
RestartSec=5
User=switchboard
WorkingDirectory=/opt/switchboard
EnvironmentFile=/etc/switchboard/env
ExecStart=/usr/bin/node /opt/switchboard/src/cli.ts serve --config /etc/switchboard/config.yaml
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/switchboard
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`serve` sends `READY=1` after startup and `WATCHDOG=1` every 20 s while the event loop runs and the DB
answers; if it stops, systemd restarts the service after 60 s.

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now switchboard
journalctl -u switchboard -f
```

## 9. First run

With the `sb` alias from the top of this runbook:

```sh
sb add-principal alice --name Alice --slack U…        # Slack profile → ⋮ → Copy member ID
sb add-principal bob --name Bob --slack U…
sb add-agent alice scout                              # prints the agent's token once
sb list
```

New principals start muted toward each other (`research_lane_default: deny`). To open the research lane:
`sb set-mute bob alice none` (Bob hears Alice's agents) and the reverse if wanted; or
`relayed_only` to go through the ops agent. A human can change their own side from Slack too: `@ops let Alice's agents
talk to mine` (or in a DM). The ops agent's `set_my_mute` changes only the asking human's side, only in a turn their
own message woke, writes an `audit` row with actor `ops:<them>` and their words (`asked`), and posts a fixed notice in
their DM on every change ("Your agents now hear Alice's agents: … Reply @ops to undo.").

**Delegate (P4).** `sb set-delegate alice alice/claude` sends what Bob's agents address to Alice (`send_message`,
`ask_human`) to alice/claude's inbox, past any mute, instead of to the ops agent, which would otherwise tell Alice
(P3). Alice's own agents still reach her through the ops agent. `sb set-delegate alice none` undoes it. Only one of the principal's own agents that isn't revoked can be
named; `sb list` shows each principal's delegate, and each change is an `audit` row (`set_delegate`). A delegate
whose token is revoked gets nothing: messages go to the human until `issue-token` reactivates it.

## 10. Agent tokens: rotate and revoke

- **Rotate:** `sb issue-token alice/scout`. The old token stops working on its next request. Give the new
  one to the agent's environment (`SWITCHBOARD_TOKEN`).
- **Revoke:** `sb revoke-token alice/scout`. Immediate. The agent still exists and keeps its history;
  `issue-token` reactivates it.
- **Audit:** every tool call and failed authentication is in the `audit` table:
  `sqlite3 /var/lib/switchboard/switchboard.db "select at, actor, action from audit order by id desc limit 50"`.
- **Leaked token:** revoke first, then check the audit table for that agent's calls since the leak.

## 11. Operating

- Smoke-test each engine end to end (a few real turns, fake Slack, temp data):
  `set -a; . /etc/switchboard/env; set +a; node scripts/smoke-engine.ts claude-api` (then `claude`, `codex`).
- Spend and turns this month: `sb usage`.
- What agents wrote for the humans (P3), still waiting for the ops agent, and questions not yet presented
  (`ask_expiry_minutes` in `config.yaml`, default 60, expires them and tells the asking agent):
  `sqlite3 /var/lib/switchboard/switchboard.db "select id, principal, from_agent, state, created_at from human_items where state = 'pending' order by created_at"`
  `sqlite3 /var/lib/switchboard/switchboard.db "select id, principal, from_agent, state, created_at from asks order by created_at desc limit 20"`
- Export a thread for a post-mortem: `sb export-thread w_… > window.md`.
- Undo an ops memory edit: `sb memory-revert <sha>` (the sha is in the #ops announcement).
- Back up `/var/lib/switchboard/switchboard.db` with `sqlite3 … ".backup /backup/switchboard.db"`.
- Upgrading: `git pull && npm ci --omit=dev && systemctl restart switchboard`.
  Migrations run at start; existing windows, approvals and audit rows stay as they are. If the release changes
  what cards say, run `sb rerender-cards` afterwards (§12).

## 12. The nightly maintenance slot (P5)

Agents don't book windows any more: they queue prod changes for one nightly slot, and each approver approves
that schedule once.

- **See it.** Ask in #ops: `@ops what's scheduled tonight?` (the ops agent reads `list_maintenance`). From the
  host:
  ```sh
  sqlite3 /var/lib/switchboard/switchboard.db "select version, start_hhmm, duration_minutes, set_by, created_at from schedules order by version desc limit 1"
  sqlite3 /var/lib/switchboard/switchboard.db "select c.version, c.id as card, a.approver, a.decision, a.decided_at, c.covers from standing_approvals a join standing_cards c on c.id = a.card_id order by a.id desc limit 10"
  sqlite3 /var/lib/switchboard/switchboard.db "select id, agent_id, resource_id, slot_start, slot_end, state from changes order by created_at desc limit 20"
  ```
- **Approve it.** Your card ("Nightly maintenance 21:00–23:00 UTC for 4 shared resources (…). Approve once?") is
  posted in #ops, tagging you, the first time a queued change needs your approval. It is one line; ask the ops agent
  (`list_maintenance`) for exactly which resources and agents it covers. Press **Approve** once; it stands
  every night until you press **Revoke** on the same card or the time changes. Only your own press counts.
  Declined or revoked by mistake: press Approve on the same card.
- **Approve it before the first change** (on deploy, or after the time changed): `sb ask-standing alice` posts
  Alice's card now, through the same path as an on-demand card. The service shows it in #ops on its next sweep
  (within a minute). It posts nothing, and says so, if her cards for the current schedule version already list
  everything the config has her approve (approved or not); if the config has since named her for more, it posts a
  card for just that. A principal who approves none of the configured resources is refused.
  Each run is in the `audit` table (`ask_standing`).
- **Config changes.** A standing approval covers only the resources and agents its card listed. After a config
  change that names an approver for more (a new resource, approvers changed back after a temporary override),
  they get a card for just the new part when a queued change needs it, or run `sb ask-standing <principal>`.
- **Change the time.** Ask the ops agent in #ops (`@ops move maintenance to 22:00 for 2 hours`). It is
  announced there, and every standing approval is void: each approver gets a new card when a queued change needs
  one. `maintenance:` in `config.yaml` only seeds the schedule on the first start.
- **Withdrawn changes.** An agent takes back a queued change before its slot with
  `report_window(id, outcome: "withdrawn", evidence: "<why>")`. It posts nothing, never runs, and the summary leaves
  it out. In the DB: `state = 'withdrawn'`, the reason in `evidence`.
- **After each slot** that had changes, one summary in #ops lists them and their outcomes. It tags you only when
  one of your agents' changes wasn't reported or failed: check prod is in a known state.
- **Urgent windows** (`request_window(..., urgent: true)`) are for what can't wait: one card of one line with its
  own buttons, rewritten in place as it is decided, starts and ends. The card shows the agent's short `title`, never
  the plan, rollback, verify or report evidence (P2): read those with `sb export-thread w_…`, or ask the ops agent.
- **Re-render the cards in the current format** (after an upgrade that changes what they say):
  ```sh
  sb rerender-cards
  ```
  It marks every standing card (every schedule version) and every live urgent-window card (proposed, approved or
  active) that Slack shows, and prints them. This process has no Slack connection, so, as with `ask-standing`, the
  running service makes the edits on its next sweep, within a minute: each card is rewritten on its own message with
  the buttons its state has now (Approve/Decline, Revoke, or none), and nothing is posted. A card Slack can no longer
  edit stays as it was. Declined, done and expired windows are left alone. It rewrites only each card's root message,
  not copies the ops agent re-posted under it (`request_approval`); those keep their old text, and their buttons still
  work. Each run is one `audit` row (`rerender_cards`).

## 13. Agents' clients and sessions

Each agent's machine runs the switchboard client, [`clients/switchboard.mjs`](../clients/switchboard.mjs) (one file,
Node ≥ 24, no dependencies), as its MCP server and hook. Setup per kit: [clients/claude-code/](../clients/claude-code/),
[clients/codex/](../clients/codex/).

- **Setup.** On the agent's machine: `SWITCHBOARD_URL=… SWITCHBOARD_TOKEN=… node switchboard.mjs install` (from
  `clients/` in a checkout). It is idempotent: it writes the env file and the client to `~/.config/switchboard/`, merges
  the hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`, sets both MCP entries to the stdio client (in
  `~/.codex/config.toml` that drops an old `url` and token), and first backs up each file it changes to
  `~/.config/switchboard/backup-<UTC time>/`. It exits 1 without credentials, or when a file can't be edited safely
  (that one is left as is). The kits' READMEs have the manual steps.
- **Credentials.** The client reads `SWITCHBOARD_URL` and `SWITCHBOARD_TOKEN` from the environment, or from the file
  `SWITCHBOARD_ENV_FILE` names (the kits use `~/.config/switchboard/env`, mode 0600), so no token sits in an MCP
  config. After `sb issue-token`, run install with the new token (or update that file) and restart the session: the MCP
  server reads it once, at start.
- **Sessions.** Each Claude Code session and Codex thread on a token is a session, `<agent>@<repo>` (`-2`, `-3` on a
  collision). Mail to an agent targets the session that last wrote in the thread, else its most recently active online
  idle one. A session keeps its name 24 h after it was last seen (15 minutes if no client could ever wake it). Once its
  client has stopped polling for 10 minutes (the session closed), or it is gone, its unread mail moves on at the next
  30 s tick, to an online session or to any. In a session, `list_team` shows them; from the host:
  `sqlite3 /var/lib/switchboard/switchboard.db "select agent_id, name, key, status, host, polled_at, seen_at from sessions where name is not null order by seen_at desc"`
- **Wakes.** A Claude Code session is woken by its `rewake` Stop hook (`"asyncRewake": true`): it holds `GET /wait`
  while the session is idle and exits 2 with the notice when mail arrives for it, which starts a turn. It re-arms at
  every turn's end; a session idle for more than its 24 h timeout with no mail waits until its next turn. A Codex
  thread is woken by its stdio client, or by the waiter its hook starts (`switchboard.mjs wake codex …`, one per
  thread, ending with its Codex), with `codex queue`. Never through Claude Code's messaging socket (K31). Locks and logs
  are in `$XDG_RUNTIME_DIR/switchboard/` (`claude-<pid>.log`, `codex-<thread>.log`). If a session isn't woken, check
  that it is online (`polled_at` within 2 minutes), the rewaker's or waiter's log, the client's stderr (`switchboard:
  wake poll failed …`), and for Codex that `codex` is on the client's `PATH`.
- **Loop guard.** An agent's message that takes it past 12 deliveries to one recipient (each relay request counts), or
  past 60 messages in all, within 10 minutes is refused with `loop_guard` and audited; nothing goes to Slack. To see them:
  `sqlite3 /var/lib/switchboard/switchboard.db "select at, actor, detail from audit where action = 'loop_guard' order by id desc limit 20"`
- **Old setups** keep working: a caller with only an HTTP MCP entry and its bearer token, or the old hook, reads all
  of its agent's mail as before. With the kit's hooks (Claude Code: the `rewake` Stop entry; Codex: `switchboard.mjs
  hook codex`), an HTTP-only session is woken too, and Claude Code's `PostToolUse` entry routes replies in the threads
  it writes in back to it.
