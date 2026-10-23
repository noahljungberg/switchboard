# Conventions

Copy the patterns already in `src/`. When in doubt, the shorter code that a reviewer can check by eye wins.

## Code

- **TypeScript, strippable.** `.ts` import extensions, `import type` for types, no enums, no namespaces, no
  constructor parameter properties (`erasableSyntaxOnly`). Run directly with `node`.
- **Few files.** A new file needs a second user or a new layer. Add it to `LAYERS` in
  `scripts/check-arch.ts`, to `ARCHITECTURE.md`, and to its design doc.
- **No abstraction without a second user**, except the three ports: `SlackPort`, `Engine`, `StatusSource`.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, `@slack/bolt`, `yaml`, `zod`. A new one must delete more
  code than it adds. Node builtins first (`node:sqlite`, `node:test`, `node:crypto`, `fetch`).
- **SQL** lives next to the code that uses it, through `one/all/run/tx` from `db.ts`. Schema changes are a
  new entry at the end of `MIGRATIONS`; never edit an old one.
- **Time** comes from `core.now()` (injectable), never `new Date()` in logic, so tests control the clock.
- **Ids:** principals `alice`, agents `alice/scout`, actors `principal:alice` / `agent:alice/scout` / `ops` /
  `system`, threads `t_<12 hex>`, windows `w_<12 hex>`, queued changes `c_<12 hex>`.

## Errors

- Refusals at the trust boundary throw `SwitchboardError(code, message)` with code `not_found`,
  `forbidden`, `invalid`, `conflict`, `muted` or `loop_guard`. The message goes verbatim to an agent or a human, so it
  says what to do next ("use request_window instead"), not just what failed.
- Don't confirm another principal's private thread exists: "not found" and "not yours" read the same.
- Everything else is a bug: log it with `console.error` and return a generic error to the caller.

## Logging

`console.error` for failures with the id involved (`slack mirror for t_… failed`). No secrets, tokens or
message bodies in logs. The `audit` table records every authenticated tool call and every admin action.

## Comments

A file opens with one comment: what it owns and its design doc. Inline comments explain *why* a rule
exists (cite the principle or spec section: `P1`, `plan §9`), never what the next line does.

## Tests

- `node:test` + `node:assert/strict`, one file per component: `test/<component>.test.ts`.
- Use `world()` from `test/fakes.ts` for a seeded core (two principals, four agents, fake clock).
- A trust-boundary rule gets a test that tries to break it, named after the rule.
- No network: fakes for Slack and engines, `127.0.0.1:0` for HTTP.

## Text the humans read (Slack, prompts, docs)

Plain, short, concrete. No "I hope this helps". Name the resource, the time and who must act.
Escape anything an agent wrote (`escapeSlack`) so it can't ping `@channel` or forge a mention.
