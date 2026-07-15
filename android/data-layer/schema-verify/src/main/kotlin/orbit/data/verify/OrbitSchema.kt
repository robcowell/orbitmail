package orbit.data.verify

import java.sql.Connection
import java.sql.DriverManager

/**
 * The canonical Orbit Mail schema (final Room schema, no historical migrations)
 * expressed as raw SQLite DDL. This is the *contract* the Room `@Entity`/
 * `@Database` layer under `android/data-layer/room/` must generate — kept in
 * lockstep with those entities (see STEP2.md for the entity↔DDL mapping).
 *
 * Differences from the Electron/Drizzle schema (deliberate, per the audit):
 *  - `accounts` has NO `token_blob` — OAuth tokens / passwords move to Android
 *    Keystore + EncryptedSharedPreferences, keeping the DB credential-free.
 *  - Only the *final* column set is declared; the desktop's additive ALTERs are
 *    not ported (a fresh Android DB starts at v1).
 *  - FTS5 is intentionally NOT the search path (audit §9: the desktop query path
 *    uses scope-aware LIKE, which also covers From/To). LIKE search is verified
 *    here; an optional FTS5 table is proven separately as a future option.
 */
object OrbitSchema {

    val DDL: List<String> = listOf(
        // ── accounts ──────────────────────────────────────────────────────────
        """
        CREATE TABLE accounts (
            id           TEXT PRIMARY KEY NOT NULL,
            provider     TEXT NOT NULL,           -- gmail | o365 | imap | pop3
            email        TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            sync_days    INTEGER NOT NULL DEFAULT 90
        )
        """,

        // ── folders ───────────────────────────────────────────────────────────
        """
        CREATE TABLE folders (
            id                    TEXT PRIMARY KEY NOT NULL,
            account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            imap_path             TEXT NOT NULL,
            name                  TEXT NOT NULL,
            type                  TEXT NOT NULL,   -- inbox|sent|drafts|trash|junk|custom
            unread_count          INTEGER NOT NULL DEFAULT 0,
            is_virtual_view       INTEGER NOT NULL DEFAULT 0,
            uid_validity          INTEGER,
            highest_synced_uid    INTEGER NOT NULL DEFAULT 0,
            last_sync_at          INTEGER,
            initial_sync_complete INTEGER NOT NULL DEFAULT 0,
            highest_modseq        TEXT,            -- 64-bit MODSEQ as string (Long)
            server_message_count  INTEGER
        )
        """,
        "CREATE INDEX folders_account_idx ON folders(account_id)",

        // ── messages ──────────────────────────────────────────────────────────
        // "references" is a SQL keyword — must stay quoted everywhere it appears.
        """
        CREATE TABLE messages (
            id              TEXT PRIMARY KEY NOT NULL,
            folder_id       TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            uid             INTEGER NOT NULL,
            message_id      TEXT,
            in_reply_to     TEXT,
            "references"    TEXT,
            thread_id       TEXT,
            from_addr       TEXT NOT NULL,
            to_addr         TEXT NOT NULL,
            cc              TEXT,
            subject         TEXT NOT NULL,
            snippet         TEXT NOT NULL,
            date            INTEGER NOT NULL,
            is_read         INTEGER NOT NULL DEFAULT 0,
            is_starred      INTEGER NOT NULL DEFAULT 0,
            flag_color      TEXT,
            has_attachments INTEGER NOT NULL DEFAULT 0,
            body_html       TEXT,
            body_text       TEXT,
            ai_analysis     TEXT,
            ai_analysis_at  INTEGER,
            sweep_cache     TEXT,
            sweep_cache_at  INTEGER
        )
        """,
        "CREATE INDEX messages_folder_date_idx ON messages(folder_id, date)",
        "CREATE INDEX messages_account_date_idx ON messages(account_id, date)",
        "CREATE INDEX messages_thread_idx ON messages(account_id, thread_id)",
        "CREATE INDEX messages_message_id_idx ON messages(message_id)",
        "CREATE UNIQUE INDEX messages_folder_uid_idx ON messages(folder_id, uid)",
        // Partial index over only the unread rows — powers the post-mutation
        // unread recount and mark-all-read scan (audit §2.1).
        "CREATE INDEX messages_folder_unread_idx ON messages(folder_id) WHERE is_read = 0",

        // ── attachments ───────────────────────────────────────────────────────
        """
        CREATE TABLE attachments (
            id         TEXT PRIMARY KEY NOT NULL,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            filename   TEXT NOT NULL,
            mime_type  TEXT NOT NULL,
            size       INTEGER NOT NULL,
            local_path TEXT
        )
        """,
        "CREATE INDEX attachments_message_idx ON attachments(message_id)",

        // ── app_preferences (generic KV: app_state, ai_sweep_meta, guards) ────
        """
        CREATE TABLE app_preferences (
            key   TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        )
        """,

        // ── sweep_tasks (persisted AI task list; composite PK) ────────────────
        """
        CREATE TABLE sweep_tasks (
            folder_id         TEXT NOT NULL,       -- real folder id or 'unified'
            id                TEXT NOT NULL,       -- stable dedupe key
            task              TEXT NOT NULL,
            priority          TEXT NOT NULL,       -- urgent|high|medium|low
            source_message_id TEXT NOT NULL,
            source_subject    TEXT NOT NULL,
            source_from       TEXT NOT NULL,
            status            TEXT NOT NULL DEFAULT 'open',  -- open|completed
            created_at        INTEGER NOT NULL,
            completed_at      INTEGER,
            PRIMARY KEY (folder_id, id)
        )
        """,
        "CREATE INDEX sweep_tasks_folder_idx ON sweep_tasks(folder_id)"
    )

    /** Optional, future search path (audit §9 keeps LIKE for v1). Proven viable. */
    val FTS5_DDL: List<String> = listOf(
        """
        CREATE VIRTUAL TABLE messages_fts USING fts5(
            message_id UNINDEXED, subject, snippet, body_text,
            content='', contentless_delete=1
        )
        """
    )

    /** Open a fresh in-memory SQLite DB with foreign keys enforced + schema applied. */
    fun openInMemory(withFts: Boolean = false): Connection {
        val conn = DriverManager.getConnection("jdbc:sqlite::memory:")
        conn.createStatement().use { it.execute("PRAGMA foreign_keys = ON") }
        val ddl = if (withFts) DDL + FTS5_DDL else DDL
        conn.createStatement().use { st -> ddl.forEach { st.execute(it.trimIndent()) } }
        return conn
    }
}
