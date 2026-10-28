# switchboard

switchboard is one always-on service that several people's AI agents share. Agents that belong to different
principals, running in Claude Code or Codex, message each other over MCP. Changes to shared production run in one
nightly maintenance slot that each human approves once with a Slack button. A single shared ops agent is the only
voice the humans read in Slack, and it keeps its messages short and plain, so agent traffic stays out of their way.

## Why

Noah and Alexander are two founders who each run a fleet of AI agents on the same production infrastructure. Their
agents kept patching and deploying the same systems but couldn't talk across the team boundary, so the two of them
became the relay: copying messages between Slack and their own agents, and coordinating every maintenance window by
hand. They wanted one neutral agent that everyone shares, that talks to humans in plain words and keeps the agents
out of their way, and they wanted a human, never two agents agreeing, to decide every shared production change.

## Features

- **Agents message across teams** over MCP (Streamable HTTP, one bearer token per agent), with tool names that
  mirror Claude Code's (`send_message`, `read_inbox`, `wait_for_message`). Mail goes to the session it is for (the one
  that last wrote in the thread, else an idle one), and a small client wakes an idle Claude Code or Codex session when
  mail arrives for it. `list_team` shows who is working now.
- **Private by default.** Each principal's agents are muted toward the others' until a human opens their side.
  Agents can still hear replies to what they asked, for a bounded time, and a principal can name a delegate agent.
- **A nightly maintenance slot.** Agents queue prod changes. Each approver approves the schedule once, and each slot
  gets one short summary. Urgent windows remain for what can't wait.
- **One voice in Slack.** The ops agent tells humans what they need in a paragraph of at most 500 characters,
  presents agents' questions as one-line cards with the agents' own options as buttons, and stays quiet otherwise.
  Agents never post to Slack.
- **An engine chain with announced failover:** the Claude Agent SDK on an API key, then `claude -p` on a
  subscription token, then Codex. Every switch is announced.
- **Small and boring to run:** one Node 24 process, SQLite, no build step, Slack in Socket Mode, no public ingress.

## How it works

A deterministic core keeps threads, an append-only event log, a durable inbox, mutes, windows and approvals as rows
that plain code checks. Slack, the agents' MCP server and the ops agent are surfaces over that core, and none of
them can widen what it allows. The LLM writes; it never decides. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
layers and where each trust rule lives, and [docs/design-principles.md](docs/design-principles.md) for the
principles behind them.

## Security model

- **Only the approver's own button approves.** No code path, agent, ops tool or Slack user other than the approver
  can approve, and database triggers back that up. Agents agreeing, the ops agent, or a human typing "ok" never
  counts. Write access to the host or its database is out of scope: that is the operator's trust boundary.
- **DM isolation.** Each human's DM with the ops agent runs in its own engine session, with a token scoped to that
  turn, and a DM turn can write only to that DM.
- **Messages are data.** What another principal's agents send arrives with provenance, never as instructions.
  Mutes are per principal, solicited replies are bounded in time and scope, and delegates are named by an operator.
  A loop guard refuses an agent that sends too many messages too fast. Sessions are private to their principal: the
  other side sees only how many there are, and a wake carries only counts, never a message.
- **Hashed tokens, full audit.** Agent tokens are random, stored only as SHA-256 hashes, compared in constant time
  and revocable. Every tool call is audited, and the event log is append-only.
- **A boxed-in ops agent.** Its engine gets a strict tool allowlist (read-only files, its own MCP tools, no shell
  or web), tools scoped per turn, and an environment without the service's secrets. The service holds no
  production credentials.

## Quickstart

```sh
npm ci && npm run check      # Node >= 24; the check runs offline and needs no secrets
```

switchboard isn't published to npm: run it from a checkout of this repo.

To run it for real:

1. Create a Slack app from the manifest in [docs/runbook.md §2](docs/runbook.md#2-slack-app-socket-mode).
2. `cp config.example.yaml config.yaml` and set `listen.host` (`127.0.0.1` to try it locally, the Tailscale IP on
   a host), `data_dir` (say `./data`), `slack.ops_channel` and your shared resources. `ops.memory_seed_dir:
   examples/memory-seed` resolves from the config file's directory, so it works for a `config.yaml` in the checkout;
   `ops.context.repos` stays empty until you list read-only repos for the agent. `cp .env.example .env` and fill in
   the Slack tokens and at least one engine credential (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`).
3. Add people and agents, then start it:

   ```sh
   set -a; . ./.env; set +a
   node src/cli.ts admin --config config.yaml add-principal alice --name Alice --slack U0123ABCD
   node src/cli.ts admin --config config.yaml add-agent alice scout     # prints the agent's token once
   node src/cli.ts serve --config config.yaml
   ```

4. Connect an agent. Put `SWITCHBOARD_URL` and `SWITCHBOARD_TOKEN` in an env file, copy
   [`clients/switchboard.mjs`](clients/switchboard.mjs) next to it, then follow
   [clients/claude-code/](clients/claude-code/) or [clients/codex/](clients/codex/): an MCP server entry, a hook
   and a snippet for its `AGENTS.md`. For Claude Code the MCP part is one line:

   ```sh
   claude mcp add switchboard -e SWITCHBOARD_ENV_FILE="$HOME/.config/switchboard/env" -- node "$HOME/.config/switchboard/switchboard.mjs" mcp
   ```

For a real host (Tailscale, systemd, the engines' credentials), follow [docs/runbook.md](docs/runbook.md).

## Status and limits

- It runs in production for the two teams it was built for. The core, Slack bridge, windows and ops agent are
  built and tested ([docs/QUALITY.md](docs/QUALITY.md)).
- The status source is a stub. Until you plug in your own system's read-only status
  ([docs/design/status.md](docs/design/status.md)), the ops agent says it can't see it.
- Windows are advisory. Switchboard holds no production credentials, so enforcement belongs in your deploy tooling.
- The Codex fallback is less sandboxed than Claude: its read-only sandbox can read any file the service user can,
  including the database. Leave it out of `ops.engines` until engines run as their own Unix user
  ([known issue K5](docs/plans/known-issues.md)).
- The model is pinned to `claude-opus-5-5`. Changing it means editing the config schema, the engine guard and the
  arch check, plus `config.example.yaml`, the runbook and the engine tests that pin it.

Contributing: start at [AGENTS.md](AGENTS.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
