# Design: Windows and approvals

## Purpose

Maintenance on shared prod resources, in two shapes (P5):

- **The nightly slot**, the normal path: one shared daily slot (UTC start, duration), approved with a Slack button on
  each approver's card (a *standing approval*): one card per approver and schedule version, plus a supplementary
  card only when the config later asks more of them.
- **Urgent windows** (plan §11), for what can't wait: request, conflict check, resource policy, approval by a
  Slack button only (P1), start, end, expiry, report.

Advisory (P1): agents check `window_status`; enforcement belongs in the systems that make prod changes (M5).

## The nightly slot (P5)

- One schedule: `start` (HH:MM UTC) and `duration_minutes` (≤ 720), with a `version`. Stored in the DB
  (`schedules`, append-only, the newest version is current), seeded once from config `maintenance` (default
  21:00 for 120 min). The slot for UTC day D runs from D at `start` for `duration_minutes`; one that starts
  late can run past midnight, and still belongs to D.
- The ops agent sets it (`set_maintenance_time`), only in a turn one human's own message in #ops woke: never in a
  DM, never when an agent, a window or a relay woke it, never when two humans did. The new row's `set_by` is
  `ops:<that human>`. A change is a new version: it voids every
  standing approval, rewrites each old card to say so (no buttons), and is announced by one system notice
  top-level in #ops. Setting the same time is no change.
- **Standing approval.** An approver approves the schedule once with their card's button; it stands until they
  revoke it or the version changes. Decisions are per card, append-only (`standing_approvals`:
  approve, decline, revoke; the latest counts), each from that approver's own Slack user (P1).
- **Cards on demand.** An approver's card is posted the first time a change needs their approval and they have no
  card for the current version, or when an operator runs `node src/cli.ts admin ask-standing <principal>` to let them
  approve ahead. It covers every (resource, principal) pair `policy` names them for, and every `require: any` pair of a
  resource they own (either owner decides those), as of posting, with Approve / Decline. Those pairs are stored with the
  card (`standing_cards.covers`) and never change; the card itself is one line that says how many resources and whose
  agents (P2), and `list_maintenance` lists the pairs in full. A card whose pairs the other owner's approval already
  covers says so ("It's approved already: nothing is needed") and offers Approve and Revoke instead, so nobody declines
  it by mistake; such pairs never share a card with ones nobody approved yet, so a Decline meant for those can't take
  away what the other owner approved. When one owner approves, each other owner gets that offer card for what they can
  now overrule (once per version: only pairs none of their cards lists). A decision rewrites the card in place, and a
  decided card keeps both Approve and Revoke: the other owner's later decision can always be overruled from it. A
  press that would change nothing is refused.
- **A wider config needs a new card.** The version doesn't change when config does, so a restart with a new
  resource, or a new approver, could otherwise widen an approval the approver never saw. An approval counts only
  for the pairs its card listed, and only under the approvers and require mode each pair had on the card: a config
  that turns "once Bob approves too" into Alice's alone (`require: any`, or `approvers: [alice]`) needs a new
  card, so a joint approval never becomes a solo one. When a queued change needs a pair that none of the approver's cards for this
  version lists, they get a *supplementary* card with just the pairs not on any of their cards yet, approved on
  its own. Narrowing withdraws cover with no new card: where `policy` no longer names an approver, their card
  doesn't count; a resource that left config, or a principal no longer among its owners, is covered for nobody,
  by resource and by change id alike (`coverage` checks config and ownership first). (Chosen
  over a per-approver version: it needs no second versioning scheme, and a card stays one approval of what it
  showed.)
- **Coverage.** The slot covers resource R for an agent of principal P when R is in config and P owns it, and:
  for `require: all`, every approver `policy(R, P)` gives has, for the current version, approved a card that lists
  (R, P) under those approvers and mode; for `require: any`, the latest decision (approve, decline or revoke) on the
  current version's cards that list (R, P) under those approvers and mode, by any owner of R or approver, is an
  approve. So either owner can revoke what the other approved, and the other approve it again; each decision is
  still that human's own button on their own card (P1).
- **Agents queue changes.** `request_window` without `urgent` queues a change (`c_<12 hex>`) for the next slot
  whose end is still in the future (the current one while it runs), with that slot's times. A new time ends the slot, now, for a
  queued change the slot covered and that had started (it may be halfway done: it reports there, and tonight's
  summary has it), and moves every other queued change whose slot hasn't ended (not started, or not covered: it
  never ran) to the next slot at the new time, as if queued now: never to a slot already over, never a day
  later than that (moving the time away and back returns it to tonight). A slot starting this very millisecond
  hasn't started. The announcement names the next slot's date. A change whose slot ran keeps those times, so the
  day's summary shows when it actually ran (the earliest start to the latest end of its changes). No window, no Slack post, no ops wake; its
  only side effect is a standing card for an approver it needs who has none yet. `start` and `duration_minutes`
  are accepted and ignored, and the result says so. It returns `{change, slot, covered, next}`.
- **Go.** `window_status(resource)` says `may_proceed` while (a) an approved, active urgent window of the agent's
  principal covers it, or (b) the slot is on, covers the resource for the agent's principal, and **this agent** has a
  queued change on it in this slot. It returns the slot, the change id and `minutes_left`. By id, a change.
- **Report.** `report_window(c_…)` records the outcome on the change (only its principal's agents, once its slot
  has started, once) and posts nothing.
- **Withdraw.** `report_window(c_…, outcome: withdrawn, evidence: <reason, ≤ 300 characters>)` takes a queued change
  back: only the agent that queued it, only while it is `queued` and before its slot starts (once the slot has
  started it may be running, so it is reported instead). A withdrawn change never counts toward `may_proceed`, is
  never marked `not_reported`, never tags anyone, and posts nothing. **The summary leaves it out**, and a slot whose
  only changes were withdrawn gets no summary at all (chosen over listing it as "withdrawn": a change that never ran
  is nothing a human must check, P3). It never ran, so its day keeps its slot (`nextSlot` ignores it), and
  `list_maintenance` shows it only until its slot is over.
- **One summary per slot.** After a slot that had changes ends, plus `window_grace_minutes`, its changes still
  queued become `not_reported`, and one top-level system notice lists each change and its outcome, within 260
  characters (clipped with "and N more", resource names to 60), under switchboard's own 300-character cap on system
  notices (`CARD_MAX` in `slack.ts`, P2). It tags the human of any change that is `not_reported` or `failed`, once,
  at the start (so a cut only takes the end of the list), to check prod is in a known state; nobody otherwise.
  Nothing else about the slot reaches Slack: no reminders, start or end notices, or overdue pages. The ops agent sees the schedule and the queue (`list_maintenance`).

## Public API (`src/windows.ts`)

- `new Windows(core, resources, {graceMinutes, maintenance})` upserts `resources` from config and seeds the
  schedule if the DB has none.
- Nightly slot: `schedule()`, `slotFor(day)`, `nextSlot()` (the next slot whose end is in the future, on a day whose
  slot hasn't run: not summarized, no change whose slot ended, no reported change from a slot that started at
  another time (a day's slot runs once), with `active`), `cards(version?)`, `coverage(resource, principal)`, `covers(approver)`, `askStanding(approvers, need?)`
  (posts missing cards, says where each stands; also `node src/cli.ts admin ask-standing`, to approve before the
  first change), `setSchedule({start, duration_minutes}, by)` (also asks again for the queued
  changes it voided; only `ops-mcp.ts` calls it, arch check), `maintenance()` (the ops agent's view). Helpers `span`, `endOf`.
- Agent-facing (agent already authenticated): `queue(agent, {resource, plan, rollback, verify, start?,
  duration_minutes?})` (request_window), `request(agent, {…, start, duration_minutes, title?})` (request_window with
  `urgent`; `title` is one line of at most 80 characters for the card, default `titleFrom(plan)`, P2), `status(agent, {id} | {resource})` (`itemStatus`, `resourceStatus`), `report(agent, {id, outcome,
  evidence})` (outcome `withdrawn` only for a queued change, before its slot); ids `c_…` are changes, `w_…` urgent windows.
- `decideStandingFromSlackButton({cardId, slackUserId, decision: approve|decline|revoke})`: **the only
  standing-approval path**, per card. Called only from `SlackBridge.onAction` (arch check `GUARDED_CALLS`);
  refuses a card of an older version and anyone but the card's approver.
- `decideFromSlackButton({windowId, slackUserId, decision: approve|decline|suggest})`: **the only approval
  path**. Called only from `SlackBridge.onAction` (arch check `GUARDED_CALLS`). Cards no longer offer `suggest`
  (P2); an old card's button still works, for a proposed window only.
- `titleFrom(plan)`: a window's default title, the plan's first line without a list marker (`1.`, `2)`, `-`, `*`, `•`),
  cut at its first sentence end at least 15 characters in (so `1.` or `e.g.` doesn't end it), at most 80 characters,
  counted in code points (as SQLite does), so an emoji is never cut in half; space, tab, CR, LF and NBSP are its
  whitespace.
  Migration 10 gave older windows the same in SQL, step for step; a test compares the two across plan shapes. Without
  a `title`, `request`'s result has a `title_note` saying what the card shows, and asks for a title when that says
  little (`maintenance`, clipped, or under 12 characters).
- `tick()`: idempotent clock; `approved → active` at start, `ended`, `overdue` at end + grace (pages the
  requester's human), `proposed → expired` at end. No T-10 reminder (P5): an urgent window starts about now.
  Then each slot with changes that ended + grace: its summary, once (`slot_summaries`). Runs every 30 s from
  `main.ts`, apart from the idle pings. Each window and each slot is ticked on its own: one that fails is logged
  and retried on the next tick, never stopping the others.
- `policy(resource, requesterPrincipal)`, `mayProceed(window, principal)`, `list(filter)`, `window(id)`,
  `fmt(iso)`. `resource(id)` (config only; refuses unknown ids) for new requests; `resourceOf(window)` for
  existing windows: a resource since removed from config.yaml falls back to its `resources` row, then its id.
- `rerenderCards()` (`node src/cli.ts admin rerender-cards`, P2): a `card_rerender` event on the thread of every standing
  card and live urgent window that Slack shows, for the service's sweep to rewrite in place; returns what it marked.
- Agent MCP tools (in `agent-mcp.ts`): `request_window`, `window_status`, `report_window`.

## State machine

`proposed → approved | declined | expired`; `approved → active | declined | expired`;
`active → done | expired`. A window's id is its thread id (`w_…`); the thread is `kind: window`,
`shared`, with the requester, every owner (as principals) and `ops` as participants.

## Rules and where they're enforced

| Rule | Code | DB (migration 2) |
|---|---|---|
| Only owners' agents request; duration ≤ policy max; start not in the past, ≤ 30 days out, with Z or an explicit UTC offset (or `now`) | `request` | `CHECK (end_at > start_at)` |
| No overlap with approved/active windows on the resource, at request and again at approval | `request`, `decideFromSlackButton` | |
| No approval once a proposed window's end has passed (a stale button pressed before the tick expires it) | `decideFromSlackButton` | |
| Approvers: policy `approvers`, else owners other than the requester's principal, else the owners. Never empty, never an agent. They are who the card asks | `policy` | `CHECK (json_array_length(approvers) > 0)` |
| Who decides: a `require: any` window, its approvers or any owner of its resource (the requester's own principal too), and the latest decision wins until it starts: an approval can be declined and a decline approved again, before its end. A `require: all` window, only its approvers, and one decline stands | `decideFromSlackButton` | migration 16: `approvals_from_approver`, `windows_state_machine` (`declined` → `approved` only for require any) |
| A flip needs a newer row: a declined window is approved again only through a newer approve, an approved one declined only through a newer decline | `decideFromSlackButton` | migration 16: `windows_reapproval_needs_newer_approve`, `windows_decline_needs_newer_decline` |
| Terms, title and approvers are fixed once requested: the title is what the approver sees (P2) | `request` | `windows_terms_fixed` (migration 10 adds `title`) |
| `approved` needs approvals rows (one for `any`, every approver for `all`) | `decideFromSlackButton` | `windows_approved_needs_approvals` |
| An approval row comes from an approver (or, require any, an owner of the resource), recorded with that principal's own Slack user id | `decideFromSlackButton` | `approvals_from_approver` (migration 16) |
| `declined` needs a decline row; approvals are append-only | | `windows_declined_needs_decline`, `approvals_no_update/delete` |
| Only legal transitions | `setState` callers | `windows_state_machine` |
| `may_proceed` only inside an active window the caller's principal asked for | `mayProceed` | |
| Only the requester's principal reports, only when active (or approved and past start) | `report` | |
| Window decisions and clock events steer the requesting agent (the core may steer) | deliveries | |
| In Slack a window is one card of one line: decisions, start, end, expiry and the report rewrite it in place; only the overdue page and a failed report are replies (P5, P2). Until a `require: any` window starts, its decided card keeps the one button that overrules the decision (Decline after an approval, Approve after a decline); an active card has none | `slack.ts` `windowAsk`, `windowUpdate` | |
| The plan, rollback, verify and report evidence never reach Slack (P2) | `slack.ts` (never rendered) | |

Nightly slot (migrations 8 and 9):

| Rule | Code | DB |
|---|---|---|
| Schedule versions only grow by one, and are never edited or deleted | `setSchedule` | `schedules_next_version`, `schedules_no_update/delete`, `CHECK`s on start and duration |
| A standing approval comes from that approver's own Slack user, for a card posted to them, of the current version | `decideStandingFromSlackButton` | `standing_from_approver`, `standing_has_card`, `standing_current_version` |
| Standing decisions are append-only; a revoke is a new row | `decideStandingFromSlackButton` | `standing_no_update/delete` |
| A card approves exactly the pairs it listed when posted, each under the approvers and mode it had; a wider or looser config gets a new card, never a wider old one | `askStanding`, `coverage` (`samePair`) | `standing_cards_fixed`, `standing_cards_no_delete` |
| Only owners' agents queue; a change's terms are fixed once queued; its slot moves only while queued | `queue`, `setSchedule` | `changes_terms_fixed`, `changes_slot_while_queued` (migration 9) |
| `may_proceed` from the slot only while it is on, covers the resource for the agent's principal, and the agent has a queued change on it in this slot | `resourceStatus`, `describeChange` | |
| Only the change's principal reports, once its slot has started, once | `reportChange` | |
| Only the agent that queued a change withdraws it, while queued and before its slot; it never runs, never counts, is never `not_reported`, and no summary lists it | `withdraw`, `tick`, `nextSlot`, `maintenance` | `CHECK` on `changes.state`, `changes_withdrawn_from_queued` (migration 12) |
| When a revoke or a new time takes the cover away mid-slot, each agent whose queued change it covered gets a steer: stop, leave prod known, report | `steerLost` (`decideStandingFromSlackButton`, `setSchedule`) | |
| One summary per slot, after end + grace; a day whose slot ran (summarized, with a change whose slot ended, or with a reported change from a slot that started at another time) never takes another slot, even if a new time makes its slot current again | `tick`, `nextSlot` | `slot_summaries` primary key |
| No agent tool and no ops tool approves; a human typing "ok" doesn't either | no such tool | |

## Implementation files

- `src/windows.ts`; schema and triggers in `src/db.ts` (migrations 2, 8, 9 and 10); Slack rendering and buttons in
  `src/slack.ts` (`window_*` and `standing_*` events, `sb_win_*` and `sb_std_*` actions); idle pings in
  `src/core.ts` (`pingIdleAgents`).

## Dependencies

`core.ts`, `db.ts`. Never Slack: it returns text for the handler to show.

## Constraints

- Times are UTC ISO strings; comparisons are string comparisons of `toISOString()` output.
- `tick()` writes each reminder once (`window_notices` primary key).

## Tests

`test/windows.test.ts`: the M2 acceptance test ("no agent tool, raw SQL, wrong person or human answer
approves; the approver's button does") calls every agent MCP tool and fails if a new tool isn't covered; the
nightly slot (seeding, slot bounds, standing approvals only by the approver's own button, revoke, a schedule
change voids them), queued changes (no Slack post, one card per approver and version until the config asks more, `window_status` before,
inside and after the slot, for covered and uncovered resources and for an agent without a change, reports, the one
summary and its clipping and tags); a v7 DB migrated with nothing lost; the live v9 shape migrated to 10, each window
given the title `titleFrom` derives (P2); one-line urgent cards that never show the plan, rollback, verify or evidence.

## Non-goals

No auto-approval: a standing approval is still one human's button press. No enforcement in the target systems
(M5). No live-state check in the policy (M4: the `note` field carries the standing rule for humans until then). One nightly slot, not a schedule per resource.

## Status

Complete for M2 and the nightly slot (P5).
