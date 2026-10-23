// SQLite storage: schema, migrations and three tiny query helpers.
// The schema is the first line of the trust boundary: CHECKs and triggers refuse states the code
// should never produce (a private window thread, an edited event). See docs/design/core.md.

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Append-only. Each entry runs once, in order, tracked by PRAGMA user_version.
export const MIGRATIONS: string[] = [
  // 1 (M1): principals, agents, threads, events, inbox, mutes, relays, audit.
  `
  CREATE TABLE principals (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slack_user_id TEXT UNIQUE,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE agents (
    id              TEXT PRIMARY KEY,               -- '<principal>/<name>'
    principal_id    TEXT NOT NULL REFERENCES principals(id),
    name            TEXT NOT NULL,
    token_sha256    TEXT UNIQUE,                    -- NULL when no live token
    token_issued_at TEXT,
    revoked_at      TEXT,
    last_seen_at    TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE (principal_id, name)
  );
  CREATE TABLE threads (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('chat', 'window', 'incident', 'dm')),
    visibility       TEXT NOT NULL CHECK (visibility = 'shared' OR visibility LIKE 'private:%'),
    title            TEXT NOT NULL,
    key              TEXT,                          -- dedupe key for auto-created threads
    slack_channel    TEXT,
    slack_ts         TEXT,
    slack_synced_seq INTEGER NOT NULL DEFAULT 0,
    state            TEXT NOT NULL DEFAULT 'open',
    created_at       TEXT NOT NULL,
    CHECK (kind <> 'dm' OR visibility LIKE 'private:%'),
    CHECK (kind NOT IN ('window', 'incident') OR visibility = 'shared')
  );
  CREATE INDEX threads_key ON threads (key);
  CREATE UNIQUE INDEX threads_slack ON threads (slack_channel, slack_ts);
  CREATE TABLE participants (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    actor     TEXT NOT NULL,                        -- 'principal:<id>' | 'agent:<id>' | 'ops'
    joined_at TEXT NOT NULL,
    muted     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, actor)
  );
  CREATE TABLE events (
    thread_id  TEXT NOT NULL REFERENCES threads(id),
    seq        INTEGER NOT NULL,
    actor      TEXT NOT NULL,
    type       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TABLE inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient  TEXT NOT NULL,                       -- 'agent:<id>' | 'ops'
    thread_id  TEXT NOT NULL,
    event_seq  INTEGER NOT NULL,
    priority   TEXT NOT NULL CHECK (priority IN ('steer', 'deferred')),
    kind       TEXT NOT NULL DEFAULT 'message',
    created_at TEXT NOT NULL,
    read_at    TEXT,
    pinged_at  TEXT,
    FOREIGN KEY (thread_id, event_seq) REFERENCES events (thread_id, seq)
  );
  CREATE INDEX inbox_unread ON inbox (recipient, read_at);
  CREATE TABLE mutes (
    principal_id       TEXT NOT NULL REFERENCES principals(id),
    muted_principal_id TEXT NOT NULL REFERENCES principals(id),
    mode               TEXT NOT NULL CHECK (mode IN ('all', 'relayed_only')),
    PRIMARY KEY (principal_id, muted_principal_id)
  );
  CREATE TABLE relays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL REFERENCES agents(id),
    to_agent   TEXT NOT NULL REFERENCES agents(id),
    thread_id  TEXT NOT NULL,
    event_seq  INTEGER NOT NULL,
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'relayed')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  `,
  // 2 (M2): resources, windows, approvals. The triggers make "approved" reachable only through an
  // approvals row written for an allowed approver's own Slack user (P1). See docs/design/windows.md.
  `
  CREATE TABLE resources (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owners     TEXT NOT NULL,                     -- json array of principal ids
    policy     TEXT NOT NULL,                     -- json
    updated_at TEXT NOT NULL
  );
  CREATE TABLE windows (
    id           TEXT PRIMARY KEY REFERENCES threads(id),   -- a window is its thread
    resource_id  TEXT NOT NULL REFERENCES resources(id),
    requested_by TEXT NOT NULL REFERENCES agents(id),
    start_at     TEXT NOT NULL,
    end_at       TEXT NOT NULL,
    plan         TEXT NOT NULL,
    rollback     TEXT NOT NULL,
    verify       TEXT NOT NULL,
    approvers    TEXT NOT NULL,                   -- json array, snapshot of the policy at request time
    require_all  INTEGER NOT NULL CHECK (require_all IN (0, 1)),
    state        TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'active', 'done', 'declined', 'expired')),
    outcome      TEXT,
    evidence     TEXT,
    reported_at  TEXT,
    created_at   TEXT NOT NULL,
    CHECK (end_at > start_at),
    CHECK (json_array_length(approvers) > 0)
  );
  CREATE INDEX windows_resource ON windows (resource_id, state);
  CREATE TABLE approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    window_id     TEXT NOT NULL REFERENCES windows(id),
    approver      TEXT NOT NULL REFERENCES principals(id),
    slack_user_id TEXT NOT NULL,
    decision      TEXT NOT NULL CHECK (decision IN ('approve', 'decline')),
    decided_at    TEXT NOT NULL
  );
  CREATE TABLE window_notices (
    window_id TEXT NOT NULL REFERENCES windows(id),
    kind      TEXT NOT NULL,
    at        TEXT NOT NULL,
    PRIMARY KEY (window_id, kind)
  );

  CREATE TRIGGER windows_born_proposed BEFORE INSERT ON windows WHEN NEW.state <> 'proposed'
    BEGIN SELECT RAISE(ABORT, 'a window starts as proposed'); END;
  CREATE TRIGGER windows_terms_fixed BEFORE UPDATE OF resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all ON windows
    BEGIN SELECT RAISE(ABORT, 'a window''s terms and approvers are fixed once requested; request a new one'); END;
  CREATE TRIGGER windows_state_machine BEFORE UPDATE OF state ON windows
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state = 'proposed' AND NEW.state IN ('approved', 'declined', 'expired')) OR
      (OLD.state = 'approved' AND NEW.state IN ('active', 'declined', 'expired')) OR
      (OLD.state = 'active'   AND NEW.state IN ('done', 'expired')))
    BEGIN SELECT RAISE(ABORT, 'illegal window state transition'); END;
  CREATE TRIGGER windows_approved_needs_approvals BEFORE UPDATE OF state ON windows
    WHEN NEW.state = 'approved' AND (
      (SELECT COUNT(DISTINCT approver) FROM approvals WHERE window_id = NEW.id AND decision = 'approve')
        < (CASE WHEN NEW.require_all = 1 THEN json_array_length(NEW.approvers) ELSE 1 END))
    BEGIN SELECT RAISE(ABORT, 'a window becomes approved only through approvals rows from its approvers'); END;
  CREATE TRIGGER windows_declined_needs_decline BEFORE UPDATE OF state ON windows
    WHEN NEW.state = 'declined' AND NOT EXISTS (SELECT 1 FROM approvals WHERE window_id = NEW.id AND decision = 'decline')
    BEGIN SELECT RAISE(ABORT, 'a window is declined only through a decline from an approver'); END;
  CREATE TRIGGER approvals_from_approver BEFORE INSERT ON approvals
    WHEN NOT EXISTS (SELECT 1 FROM principals WHERE id = NEW.approver AND slack_user_id = NEW.slack_user_id)
      OR NOT EXISTS (SELECT 1 FROM windows w, json_each(w.approvers) a WHERE w.id = NEW.window_id AND a.value = NEW.approver)
    BEGIN SELECT RAISE(ABORT, 'an approval must come from one of the window''s approvers, from their own Slack user'); END;
  CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
    BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
  CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
    BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
  `,
  // 3 (M3): ops agent state. Engine sessions are per thread (a DM has its own), and how far the ops agent
  // has read each thread. kv holds the engine failover state across restarts.
  `
  ALTER TABLE threads ADD COLUMN ops_seen_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN claude_session TEXT;
  ALTER TABLE threads ADD COLUMN codex_session TEXT;
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 4: an ordered engine chain (P7) needs a session per (thread, engine), not a column per engine.
  // threads.claude_session/codex_session are left in place, unused.
  `
  CREATE TABLE engine_sessions (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    engine    TEXT NOT NULL,
    session   TEXT NOT NULL,
    PRIMARY KEY (thread_id, engine)
  );
  INSERT INTO engine_sessions SELECT id, 'claude', claude_session FROM threads WHERE claude_session IS NOT NULL;
  INSERT INTO engine_sessions SELECT id, 'codex', codex_session FROM threads WHERE codex_session IS NOT NULL;
  `,
  // 5: how far each engine's session has read its thread. A resumed session must get everything since its own
  // last turn, including turns another engine answered meanwhile; threads.ops_seen_seq stays the "answered" mark.
  // Existing sessions are dropped: only the shared mark was kept before, which can be past what one engine read,
  // so its next turn starts a fresh session with the thread's history instead of resuming at a guess.
  `
  ALTER TABLE engine_sessions ADD COLUMN seen_seq INTEGER NOT NULL DEFAULT 0;
  DELETE FROM engine_sessions;
  `,
  // 6 (P3): the old mirror gave every shared thread a header post as its Slack root. Chat threads with no human
  // in them no longer show in Slack except for pages, so their roots go: the next page is a new top-level post,
  // not a reply under an old (maybe deleted) header. slack_synced_seq stays, so nothing is posted again.
  `
  UPDATE threads SET slack_channel = NULL, slack_ts = NULL
  WHERE kind = 'chat' AND slack_ts IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.thread_id = threads.id AND p.actor LIKE 'principal:%');
  `,
  // 7 (P3): whether a participant was in a thread for an event is decided by seq, not by comparing two
  // timestamps that can share a millisecond. joined_seq is the thread's last seq when the actor joined; existing
  // rows get the last event written before their joined_at, which is what the timestamp rule decided for them.
  `
  ALTER TABLE participants ADD COLUMN joined_seq INTEGER NOT NULL DEFAULT 0;
  UPDATE participants SET joined_seq = COALESCE(
    (SELECT MAX(e.seq) FROM events e WHERE e.thread_id = participants.thread_id AND e.created_at < participants.joined_at), 0);
  `,
  // 8 (P5): one nightly maintenance slot, approved per card. Schedules are append-only versions (the current one is
  // the newest). A standing-approval card lists the (resource, principal) pairs it approves, each with the approvers
  // and mode it had then, fixed when posted, so a later config can't widen what an approver saw or make a joint
  // approval a solo one; such a config posts them a new card. A standing approval is a
  // row from the approver its card was posted to, from their own Slack user, for a card of the current version (P1).
  `
  CREATE TABLE schedules (
    version          INTEGER PRIMARY KEY,
    start_hhmm       TEXT NOT NULL CHECK (start_hhmm GLOB '[0-2][0-9]:[0-5][0-9]' AND start_hhmm < '24:00'),
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
    set_by           TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );
  CREATE TABLE standing_cards (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    version   INTEGER NOT NULL REFERENCES schedules(version),
    approver  TEXT NOT NULL REFERENCES principals(id),
    covers    TEXT NOT NULL CHECK (json_valid(covers) AND json_array_length(covers) > 0), -- json [[resource, principal, 'any'|'all', [approvers]], ...]
    thread_id TEXT NOT NULL REFERENCES threads(id),
    posted_at TEXT NOT NULL
  );
  CREATE INDEX standing_cards_version ON standing_cards (version, approver);
  CREATE TABLE standing_approvals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id       INTEGER NOT NULL REFERENCES standing_cards(id),
    approver      TEXT NOT NULL REFERENCES principals(id),
    slack_user_id TEXT NOT NULL,
    decision      TEXT NOT NULL CHECK (decision IN ('approve', 'decline', 'revoke')),
    decided_at    TEXT NOT NULL
  );
  CREATE TRIGGER schedules_next_version BEFORE INSERT ON schedules
    WHEN NEW.version <> COALESCE((SELECT MAX(version) FROM schedules), 0) + 1
    BEGIN SELECT RAISE(ABORT, 'a schedule version is the last one plus one'); END;
  CREATE TRIGGER schedules_no_update BEFORE UPDATE ON schedules
    BEGIN SELECT RAISE(ABORT, 'schedules are append-only; set a new version'); END;
  CREATE TRIGGER schedules_no_delete BEFORE DELETE ON schedules
    BEGIN SELECT RAISE(ABORT, 'schedules are append-only; set a new version'); END;
  CREATE TRIGGER standing_cards_fixed BEFORE UPDATE ON standing_cards
    BEGIN SELECT RAISE(ABORT, 'a standing card is fixed once posted: it approves what its approver saw'); END;
  CREATE TRIGGER standing_cards_no_delete BEFORE DELETE ON standing_cards
    BEGIN SELECT RAISE(ABORT, 'a standing card is fixed once posted: it approves what its approver saw'); END;
  CREATE TRIGGER standing_from_approver BEFORE INSERT ON standing_approvals
    WHEN NOT EXISTS (SELECT 1 FROM principals WHERE id = NEW.approver AND slack_user_id = NEW.slack_user_id)
    BEGIN SELECT RAISE(ABORT, 'a standing approval must come from the approver, from their own Slack user'); END;
  CREATE TRIGGER standing_has_card BEFORE INSERT ON standing_approvals
    WHEN NOT EXISTS (SELECT 1 FROM standing_cards WHERE id = NEW.card_id AND approver = NEW.approver)
    BEGIN SELECT RAISE(ABORT, 'a standing approval comes from the approver its card was posted to'); END;
  CREATE TRIGGER standing_current_version BEFORE INSERT ON standing_approvals
    WHEN (SELECT version FROM standing_cards WHERE id = NEW.card_id) <> (SELECT MAX(version) FROM schedules)
    BEGIN SELECT RAISE(ABORT, 'a standing approval is for the current schedule only'); END;
  CREATE TRIGGER standing_no_update BEFORE UPDATE ON standing_approvals
    BEGIN SELECT RAISE(ABORT, 'standing approvals are append-only; a revoke is a new row'); END;
  CREATE TRIGGER standing_no_delete BEFORE DELETE ON standing_approvals
    BEGIN SELECT RAISE(ABORT, 'standing approvals are append-only; a revoke is a new row'); END;
  `,
  // 9 (P5): agents queue changes for the nightly slot instead of requesting windows. A change belongs to the
  // slot of one UTC day, with that slot's times. While queued, a new schedule may end its slot early (it was
  // covered and in progress) or move it to the next slot (it never ran); once reported, it keeps the slot it ran in.
  // Each day that had changes gets one Slack summary, recorded so it's posted once.
  `
  CREATE TABLE changes (
    id          TEXT PRIMARY KEY,                    -- c_<12 hex>
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    resource_id TEXT NOT NULL REFERENCES resources(id),
    plan        TEXT NOT NULL,
    rollback    TEXT NOT NULL,
    verify      TEXT NOT NULL,
    slot_day    TEXT NOT NULL CHECK (slot_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    slot_start  TEXT NOT NULL,
    slot_end    TEXT NOT NULL CHECK (slot_end > slot_start),
    state       TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'done', 'rolled_back', 'failed', 'partial', 'not_reported')),
    evidence    TEXT,
    reported_at TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX changes_slot ON changes (slot_day, state);
  CREATE TRIGGER changes_terms_fixed BEFORE UPDATE OF agent_id, resource_id, plan, rollback, verify ON changes
    BEGIN SELECT RAISE(ABORT, 'a change''s terms are fixed once queued; queue a new one'); END;
  CREATE TRIGGER changes_slot_while_queued BEFORE UPDATE OF slot_day, slot_start, slot_end ON changes WHEN OLD.state <> 'queued'
    BEGIN SELECT RAISE(ABORT, 'a change moves to another slot only while it is queued; once reported it keeps the slot it ran in'); END;
  CREATE TABLE slot_summaries (
    slot_day  TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    posted_at TEXT NOT NULL
  );
  -- An urgent window's decisions, clock and reports no longer wake the ops agent (P5). Wakes of those kinds still
  -- unread would wake it once on deploy, for events it no longer answers.
  UPDATE inbox SET read_at = created_at
  WHERE recipient = 'ops' AND read_at IS NULL AND kind IN ('approval_decision', 'window_clock', 'window_report');
  `,
  // 10 (P2): an urgent window's Slack card is one line, so it shows a short title, never the plan. Windows from before
  // get the title windows.ts titleFrom() gives their plan, step for step: its first line without a list marker, cut at
  // the first sentence end at least 15 characters in, without the closing punctuation, at most 80 characters. Whitespace
  // is space, tab, CR, LF and NBSP, and SQLite counts characters in code points, as titleFrom does. The title is what
  // the approver sees, so it is fixed like the other terms.
  `
  ALTER TABLE windows ADD COLUMN title TEXT NOT NULL DEFAULT '';
  UPDATE windows SET title = trim(plan, char(32, 9, 10, 13, 160));
  UPDATE windows SET title = substr(title, 1, instr(title || char(10), char(10)) - 1);
  UPDATE windows SET title = replace(replace(replace(title, char(13), ' '), char(9), ' '), char(160), ' ');
  UPDATE windows SET title = CASE
    WHEN title GLOB '[0-9][.)] *' THEN ltrim(substr(title, 3), ' ')
    WHEN title GLOB '[0-9][0-9][.)] *' THEN ltrim(substr(title, 4), ' ')
    WHEN title GLOB '[0-9][0-9][0-9][.)] *' THEN ltrim(substr(title, 5), ' ')
    WHEN substr(title, 1, 2) IN ('- ', '* ', '• ') THEN ltrim(substr(title, 3), ' ')
    ELSE title END;
  UPDATE windows SET title = substr(title, 1, 15 + instr(substr(title, 16) || '. ', '. ') - 1);
  UPDATE windows SET title = substr(title, 1, 15 + instr(substr(title, 16) || '! ', '! ') - 1);
  UPDATE windows SET title = substr(title, 1, 15 + instr(substr(title, 16) || '? ', '? ') - 1);
  UPDATE windows SET title = rtrim(title, '.!?:;, ');
  UPDATE windows SET title = 'maintenance' WHERE title = '';
  UPDATE windows SET title = rtrim(substr(title, 1, 79)) || '…' WHERE length(title) > 80;
  DROP TRIGGER IF EXISTS windows_terms_fixed;
  CREATE TRIGGER windows_terms_fixed BEFORE UPDATE OF resource_id, requested_by, start_at, end_at, plan, rollback, verify, approvers, require_all, title ON windows
    BEGIN SELECT RAISE(ABORT, 'a window''s terms and approvers are fixed once requested; request a new one'); END;
  `,
  // 11 (P4): a principal may name one of its own agents as its delegate: what another principal's agents address to
  // that human goes to the delegate's inbox instead of reaching them. Only an agent of that principal, not revoked when it is
  // named. A new principal has no agents yet, so it is born without one. Every existing principal starts with none.
  // Each mute records when it was last set: a solicited reply counts only what the asker wrote since, so an earlier
  // opening never outlives a later mute. `set_mark` is the newest event's rowid then (events are append-only, so rowids
  // only grow): "since" is decided by it, not by clocks that can tie or step back; `set_at` is for people.
  // Existing mutes count from this migration.
  `
  ALTER TABLE mutes ADD COLUMN set_at TEXT NOT NULL DEFAULT '';
  ALTER TABLE mutes ADD COLUMN set_mark INTEGER NOT NULL DEFAULT 0;
  UPDATE mutes SET set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), set_mark = (SELECT COALESCE(MAX(rowid), 0) FROM events);
  ALTER TABLE principals ADD COLUMN delegate_agent_id TEXT REFERENCES agents(id);
  CREATE TRIGGER principals_delegate_born_none BEFORE INSERT ON principals WHEN NEW.delegate_agent_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a delegate must be one of the principal''s own agents that isn''t revoked'); END;
  CREATE TRIGGER principals_delegate_own_live BEFORE UPDATE OF delegate_agent_id ON principals
    WHEN NEW.delegate_agent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.delegate_agent_id AND principal_id = NEW.id AND revoked_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'a delegate must be one of the principal''s own agents that isn''t revoked'); END;
  `,
  // 12: a queued change can be withdrawn by its own agent before its slot (report_window outcome withdrawn). SQLite
  // can't alter a CHECK, so the table is rebuilt: every row with its rowid (ties order by it), then its index and
  // triggers as migration 9 made them, plus one that lets only a queued change become withdrawn.
  `
  CREATE TABLE changes_v12 (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    resource_id TEXT NOT NULL REFERENCES resources(id),
    plan        TEXT NOT NULL,
    rollback    TEXT NOT NULL,
    verify      TEXT NOT NULL,
    slot_day    TEXT NOT NULL CHECK (slot_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    slot_start  TEXT NOT NULL,
    slot_end    TEXT NOT NULL CHECK (slot_end > slot_start),
    state       TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'done', 'rolled_back', 'failed', 'partial', 'not_reported', 'withdrawn')),
    evidence    TEXT,
    reported_at TEXT,
    created_at  TEXT NOT NULL
  );
  INSERT INTO changes_v12 (rowid, id, agent_id, resource_id, plan, rollback, verify, slot_day, slot_start, slot_end, state, evidence, reported_at, created_at)
    SELECT rowid, id, agent_id, resource_id, plan, rollback, verify, slot_day, slot_start, slot_end, state, evidence, reported_at, created_at FROM changes;
  DROP TABLE changes;
  ALTER TABLE changes_v12 RENAME TO changes;
  CREATE INDEX changes_slot ON changes (slot_day, state);
  CREATE TRIGGER changes_terms_fixed BEFORE UPDATE OF agent_id, resource_id, plan, rollback, verify ON changes
    BEGIN SELECT RAISE(ABORT, 'a change''s terms are fixed once queued; queue a new one'); END;
  CREATE TRIGGER changes_slot_while_queued BEFORE UPDATE OF slot_day, slot_start, slot_end ON changes WHEN OLD.state <> 'queued'
    BEGIN SELECT RAISE(ABORT, 'a change moves to another slot only while it is queued; once reported it keeps the slot it ran in'); END;
  CREATE TRIGGER changes_withdrawn_from_queued BEFORE UPDATE OF state ON changes WHEN NEW.state = 'withdrawn' AND OLD.state <> 'queued'
    BEGIN SELECT RAISE(ABORT, 'only a queued change can be withdrawn'); END;
  `,
  // 13 (P3): agents never post to Slack. What an agent addresses to a human is an item for the ops agent: the event it
  // reads (in that human's DM with it for their own agents', else a shared thread), pending until it tells the human
  // (`told`, with where) or decides they don't need it (`skipped`, with why). Handled once.
  `
  CREATE TABLE human_items (
    id         TEXT PRIMARY KEY,                    -- m_<12 hex>
    principal  TEXT NOT NULL REFERENCES principals(id),
    from_agent TEXT NOT NULL REFERENCES agents(id),
    thread_id  TEXT NOT NULL,
    event_seq  INTEGER NOT NULL,
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'told', 'skipped')),
    outcome    TEXT,
    created_at TEXT NOT NULL,
    handled_at TEXT,
    FOREIGN KEY (thread_id, event_seq) REFERENCES events (thread_id, seq)
  );
  CREATE INDEX human_items_pending ON human_items (thread_id, state);
  CREATE TRIGGER human_items_once BEFORE UPDATE OF state ON human_items WHEN OLD.state <> 'pending'
    BEGIN SELECT RAISE(ABORT, 'an item for a human is handled once'); END;
  `,
  // 14 (P3): ask_human posts no card. The question waits as an ask (its ask_human event, where the ops agent reads it)
  // until the ops agent presents it in its own words with the agent's options as buttons (`presented`, with that text
  // and where the card is), drops it (`skipped`), or it expires unpresented (`expired`). It leaves `pending` once.
  `
  CREATE TABLE asks (
    id          TEXT PRIMARY KEY,                   -- q_<12 hex>
    principal   TEXT NOT NULL REFERENCES principals(id),
    from_agent  TEXT NOT NULL REFERENCES agents(id),
    thread_id   TEXT NOT NULL,
    event_seq   INTEGER NOT NULL,
    state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'presented', 'skipped', 'expired')),
    text        TEXT,
    card_thread TEXT REFERENCES threads(id),
    created_at  TEXT NOT NULL,
    handled_at  TEXT,
    answered_at TEXT,
    FOREIGN KEY (thread_id, event_seq) REFERENCES events (thread_id, seq),
    UNIQUE (thread_id, event_seq)
  );
  CREATE INDEX asks_pending ON asks (state, created_at);
  CREATE INDEX asks_card ON asks (card_thread, state);
  CREATE TRIGGER asks_once BEFORE UPDATE OF state ON asks WHEN OLD.state <> 'pending'
    BEGIN SELECT RAISE(ABORT, 'an ask is presented, dropped or expired once'); END;
  CREATE TRIGGER asks_text_fixed BEFORE UPDATE OF text, principal, from_agent, thread_id, event_seq ON asks WHEN OLD.state <> 'pending'
    BEGIN SELECT RAISE(ABORT, 'a presented ask''s card is fixed'); END;
  -- An agent's ask_human from before this migration that the mirror never posted (past its thread's slack_synced_seq) and nobody
  -- answered would now never post, wake or expire: it becomes a pending ask as of when it was asked, so it expires on the
  -- next tick and its agent is told "not presented". One the mirror posted keeps its old card and buttons.
  INSERT INTO asks (id, principal, from_agent, thread_id, event_seq, created_at)
    SELECT 'q_' || lower(hex(randomblob(6))), json_extract(e.body, '$.who'), substr(e.actor, 7), e.thread_id, e.seq, e.created_at
    FROM events e JOIN threads t ON t.id = e.thread_id
    WHERE e.type = 'ask_human' AND e.actor LIKE 'agent:%' AND e.seq > t.slack_synced_seq
      AND json_extract(e.body, '$.who') IN (SELECT id FROM principals) AND substr(e.actor, 7) IN (SELECT id FROM agents)
      AND NOT EXISTS (SELECT 1 FROM events a WHERE a.thread_id = e.thread_id AND a.type = 'human_answer' AND json_extract(a.body, '$.ask_seq') = e.seq);
  `,
  // 15: sessions. An agent's token can have many live sessions, keyed per agent by its client ('claude:<session id>',
  // 'codex:<thread id>'), each named uniquely among the agent's current ones (NULL once gone) and holding what its client
  // last said about it: hints, never authority. An inbox row may target one session (NULL: any session of the agent reads
  // it, as before). inbox_told: which sessions were told about which rows (a wake or a hook notice), so a message wakes
  // each session at most once, even when it moves between them. routes: the session that last wrote in a thread for its
  // agent, where replies go (NULL: none, so any of its sessions reads them); changes, asks and items for humans keep the
  // session that queued, asked or wrote them.
  // Existing rows: no sessions, every inbox row untargeted.
  `
  CREATE TABLE sessions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id  TEXT NOT NULL REFERENCES agents(id),
    key       TEXT NOT NULL,
    name      TEXT,
    host      TEXT,
    cwd       TEXT,
    repo      TEXT,
    branch    TEXT,
    title     TEXT,
    status    TEXT CHECK (status IN ('busy', 'idle', 'waiting')),
    by_client INTEGER NOT NULL DEFAULT 0,             -- status comes from the client (Claude's registry), which hooks don't override
    hooks     INTEGER NOT NULL DEFAULT 0,
    polled_at TEXT,                                   -- a client polled /wait for it: it can be woken
    waited_at TEXT,                                   -- it held wait_for_message
    active_at TEXT NOT NULL,
    seen_at   TEXT NOT NULL,
    UNIQUE (agent_id, key)
  );
  CREATE UNIQUE INDEX sessions_name ON sessions (agent_id, name);
  ALTER TABLE inbox ADD COLUMN session INTEGER REFERENCES sessions(id);
  CREATE INDEX inbox_session ON inbox (session, read_at);
  CREATE TABLE inbox_told (
    inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    session  INTEGER NOT NULL REFERENCES sessions(id),
    PRIMARY KEY (inbox_id, session)
  );
  CREATE TABLE routes (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    agent_id  TEXT NOT NULL REFERENCES agents(id),
    session   INTEGER REFERENCES sessions(id),
    PRIMARY KEY (thread_id, agent_id)
  );
  ALTER TABLE changes ADD COLUMN session INTEGER REFERENCES sessions(id);
  ALTER TABLE asks ADD COLUMN session INTEGER REFERENCES sessions(id);
  ALTER TABLE human_items ADD COLUMN session INTEGER REFERENCES sessions(id);
  `,
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

const statements = new WeakMap<Db, Map<string, StatementSync>>();
function stmt(db: Db, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return stmt(db, sql).get(...params) as T | undefined;
}
export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return stmt(db, sql).all(...params) as T[];
}
export function run(db: Db, sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
  const r = stmt(db, sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

// Nested calls join the outer transaction. afterCommit callbacks run once the outermost commit lands,
// so listeners (Slack mirror, ops wake) never act on rows that a rollback later removes.
const depth = new WeakMap<Db, number>();
const pending = new WeakMap<Db, Array<() => void>>();
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  pending.set(db, []);
  let callbacks: Array<() => void> = [];
  try {
    const result = fn();
    db.exec('COMMIT');
    callbacks = pending.get(db) ?? [];
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
    pending.delete(db);
    for (const cb of callbacks) cb();
  }
}

export function afterCommit(db: Db, fn: () => void): void {
  if ((depth.get(db) ?? 0) > 0) pending.get(db)!.push(fn);
  else fn();
}
