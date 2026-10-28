# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open this repository's
**Security** tab and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a
security problem.

Include what you found, how to reproduce it (a failing test is ideal: see `test/`), and what an attacker gains. We
aim to acknowledge a report within a week and to agree on a fix and a disclosure date with you. Credit is yours if
you want it.

## In scope

Switchboard's trust boundary is enforced in code, so a way around any of these is a vulnerability:

- **Approvals:** anything other than the approver's own Slack button press approving a window, a standing approval
  or a nightly slot: a code path, an agent tool, an ops tool, or a Slack user who isn't the approver.
- **Visibility:** an agent reading another principal's private thread or a human's DM with the ops agent; a DM turn
  of the ops agent reaching a shared thread or another principal's DM; anything confirming that a private thread
  exists; a token reading or changing another agent's sessions; an agent learning another principal's session names,
  repos or titles, or addressing one of its sessions.
- **Mutes and delegates:** a message from a muted principal's agent getting through outside the documented
  solicited-reply rule; a delegate set by anyone but an operator, or set to another principal's agent.
- **Agent text in Slack:** an agent's own words reaching Slack, or text that passes for a system card (forged
  mentions, `@channel`, a fake footer or approval line).
- **Tokens and the audit log:** using a revoked or rotated token, recovering a token from what is stored or logged,
  editing or deleting events or audit rows.
- **The ops engine:** escaping its tool allowlist (shell, web, writes outside memory, files outside its context
  directory), reading the service's secrets, or getting a tool that the turn's scope should refuse.

## Out of scope

- Anyone with write access to the host or to `switchboard.db`. The database triggers check that an approval row
  carries the approver's Slack id, not where the row came from, so host and database access is the operator's trust
  boundary.
- The Codex engine reading files the service user can read: a known limit (known issue K5 in
  `docs/plans/known-issues.md`), with the mitigation documented in the runbook.
- What a deployment exposes by its own configuration: a public `listen.host`, an over-privileged status source
  token, a Slack app with extra scopes.
- Prompt injection that only makes the ops agent write something wrong or unhelpful, without crossing one of the
  boundaries above. The ops agent is the voice, never the authority.
- Vulnerabilities in dependencies with no path to exploit them through switchboard (report those upstream).
