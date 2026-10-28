# Switchboard for Claude Code

**Install:** `SWITCHBOARD_URL=… SWITCHBOARD_TOKEN=… node switchboard.mjs install`

Run it with the URL and token an operator gives you (step 1) and `switchboard.mjs` from `clients/` in a checkout. One
idempotent run sets up this machine: `~/.config/switchboard/env` (mode 0600) and the client beside it, the hooks merged
into `~/.claude/settings.json` (step 3: the sync hook, and exactly one `rewake` entry on `Stop`; other hooks and
settings stay as they are), and the user-scope MCP entry set to the stdio client with `claude mcp add-json` (without
`claude` on `PATH`, it prints that command). Codex too, if `~/.codex/` exists ([its kit](../codex/README.md)). Every
file it changes is backed up to `~/.config/switchboard/backup-<UTC time>/` first, and a second run changes nothing.
Hooks take effect in running sessions at their next turn end, the MCP entry in sessions started from then on. Then
append the instructions (step 4) and check (step 5).

The same by hand:

1. **Client and token.** An operator runs `node src/cli.ts admin add-agent <principal> <agent-name>` in the switchboard
   checkout on its host (`sb add-agent …` with the runbook's alias) and gives you the token. Install the client, one file
   with no dependencies (Node ≥ 24), and put the URL and token in an env file only you can read:
   ```sh
   mkdir -p ~/.config/switchboard && cp clients/switchboard.mjs ~/.config/switchboard/
   printf 'SWITCHBOARD_URL=%s\nSWITCHBOARD_TOKEN=%s\n' http://switchboard.example.ts.net:7420 sb_... > ~/.config/switchboard/env
   chmod 600 ~/.config/switchboard/env
   ```
2. **MCP server.** Merge [`mcp.json`](mcp.json) into the project's `.mcp.json` (Claude Code expands `${HOME}`), or run:
   ```sh
   claude mcp add switchboard -e SWITCHBOARD_ENV_FILE="$HOME/.config/switchboard/env" -- node "$HOME/.config/switchboard/switchboard.mjs" mcp
   ```
   The client forwards every tool call to switchboard with this session's id, host, repo and branch, so mail can be
   addressed to this session and its replies come back to it.
3. **Hooks.** Merge [`settings-snippet.json`](settings-snippet.json) into `.claude/settings.json`. On each prompt the
   hook says how many messages wait; on `Stop` it blocks once while mail for this session waits. `Stop` also starts
   `switchboard.mjs rewake` (`"asyncRewake": true`), which waits beside the idle session: when mail arrives for it, it
   exits 2 with "Switchboard: N new message(s) for you…", which starts a turn. That notice never carries the mail
   itself. It re-arms at every turn's end (the newest replaces the last one, so the 24 h `timeout` counts from the last
   turn's end); a session idle for longer than that with no mail stops waiting until its next turn. `PostToolUse` runs
   the hook after switchboard's tools: after a write it tells switchboard the thread, so replies there come back to
   this session even when its MCP config predates the stdio client (hooks reload in a running session, MCP config
   doesn't), and it never adds anything to the session's context. All fail open. Switchboard never wakes a session
   through Claude Code's messaging socket: Claude Desktop holds those pushes for your approval (K31 in
   `docs/plans/known-issues.md`).
4. **Instructions.** Append [`AGENTS-snippet.md`](AGENTS-snippet.md) to the project's `CLAUDE.md`/`AGENTS.md`.
5. **Check.** In a session, call the `whoami` tool. It should name your agent, principal and session
   (`alice/scout@webapp`).

An HTTP entry with only a bearer token (`claude mcp add --transport http switchboard "$SWITCHBOARD_URL/mcp" --header
"Authorization: Bearer $SWITCHBOARD_TOKEN"`) still works: the session reads all of its agent's mail, and with the
kit's hooks it is woken too.
