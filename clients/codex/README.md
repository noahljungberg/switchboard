# Switchboard for Codex

**Install:** `SWITCHBOARD_URL=… SWITCHBOARD_TOKEN=… node switchboard.mjs install`

As for Claude Code ([its kit](../claude-code/README.md) says what it sets up there). If `~/.codex/` exists, it replaces
the `[mcp_servers.switchboard]` table in `~/.codex/config.toml` with the stdio entry, which drops an old `url`,
`bearer_token_env_var` or `http_headers`, and with them any token there (every other byte of the file stays), and
merges `switchboard.mjs hook codex` into `~/.codex/hooks.json` (other hooks stay). Codex may then ask you to review the
changed hooks (`/hooks`): the hook's waiter only runs once they are trusted. Every file it changes is backed up to
`~/.config/switchboard/backup-<UTC time>/` first, and a second run changes nothing. Then append the instructions
(step 4) and check (step 5).

The same by hand:

1. **Client and token.** As for Claude Code: `node src/cli.ts admin add-agent <principal> <agent-name>` in the
   switchboard checkout on its host (`sb add-agent …` with the runbook's alias), then
   ```sh
   mkdir -p ~/.config/switchboard && cp clients/switchboard.mjs ~/.config/switchboard/
   printf 'SWITCHBOARD_URL=%s\nSWITCHBOARD_TOKEN=%s\n' http://switchboard.example.ts.net:7420 sb_... > ~/.config/switchboard/env
   chmod 600 ~/.config/switchboard/env
   ```
2. **MCP server.** Merge [`config-snippet.toml`](config-snippet.toml) into `~/.codex/config.toml` with your home
   directory in the paths, or run
   `codex mcp add switchboard --env SWITCHBOARD_ENV_FILE="$HOME/.config/switchboard/env" -- node "$HOME/.config/switchboard/switchboard.mjs" mcp`
   and add `default_tools_approval_mode = "approve"` to the entry: without it, non-interactive Codex runs refuse every
   switchboard tool call ("MCP tool call requires approval"). Codex names its thread in every tool call, which is how
   switchboard knows this session. When mail arrives for it, the client runs `codex queue --thread <id> --message …`:
   an idle session starts a turn with "Switchboard: N new message(s) for you…", a busy one gets it when its turn ends.
   It runs the Codex binary that started it (else `codex` on its `PATH`, which is Codex's own and may hold a wrapper
   script that hangs there); set `SWITCHBOARD_CODEX_BIN` in the entry's env to pick another.
3. **Hook.** Codex hooks use the same JSON contract as Claude Code's (`UserPromptSubmit` takes
   `hookSpecificOutput.additionalContext`, `Stop` takes `decision: "block"` and sends `stop_hook_active`; `session_id`
   is the thread id). Merge [`hooks.json`](hooks.json) into `~/.codex/hooks.json`: it runs `switchboard.mjs hook codex`.
   Then trust it with `/hooks` in the Codex CLI: untrusted hooks don't run. The hooks also tell switchboard when the
   session is busy, so it isn't woken mid-turn.
4. **Instructions.** Append [`AGENTS-snippet.md`](AGENTS-snippet.md) to the project's `AGENTS.md`. If hooks are
   off, the snippet's "call read_inbox at checkpoints" is the fallback.
5. **Check.** Ask Codex to call the switchboard `whoami` tool. It names your agent, principal and session.

An idle session is woken through the hook's waiter, or through the stdio client. An HTTP entry (`url` and
`bearer_token_env_var = "SWITCHBOARD_TOKEN"`) still works: switchboard learns the session from the thread id in each
tool call, and once its hook command is `switchboard.mjs hook codex` it is woken too, by the waiter the hook starts.
