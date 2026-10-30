**English** · [简体中文](README.zh-CN.md)

# Agent Inspector

Browse the disk usage and session history of ZCode, Codex, Claude Code, Cursor, and DeepSeek Harness on your machine, check what cleanup will actually take with it, then choose what to delete; you can also scan session bodies read-only to see whether credentials have ever leaked. Uses only built-in Node.js modules, with no third-party runtime dependencies.

<p align="center">
  <img src="docs/images/overview.png" width="880" alt="Overview: disk usage and cleanup space by tier, file list on the left, sessions grouped by tool on the right">
</p>

<p align="center">
  <img src="docs/images/all-tools.png" width="880" alt="All view: read-only summary of 319 sessions across five tools, aggregated by folder">
</p>

The interface has two columns: the file list on the left is split by "what happens if you delete it" into three tiers — safe to clean, clean with caution, and do not delete; session management on the right is collapsible by tool and folder, with each session showing its size and last-used time. Cleaning requires ticking items and confirming first; deletion goes to the Trash by default.

## Getting started

Requires Node.js ≥ 22.5. macOS supports every operation; other systems support scanning and file backup deletion, and database writes additionally require a working `pgrep` process check.

```bash
git clone https://github.com/cookabc/agent-inspector.git
cd agent-inspector
npm start
```

The browser opens the [local page](http://127.0.0.1:4173) automatically. The server listens only on `127.0.0.1` and offers no remote access.

| Flag | Default | Purpose |
|---|---|---|
| `--port <n>` | `4173`, also settable via `PORT` | Listening port; `0` assigns a free port automatically |
| `--app <id>` | all | `zcode`, `codex`, `claude`, `cursor`, `dsh` |
| `--root <dir>` | the tool's own data directory | Overrides the first target of the selected tool; without `--app`, the ZCode category is used |
| `--backup-dir <dir>` | `backups/` under the project | Sets the directory where pre-cleanup backups are stored |
| `--no-open` | off | Does not open the browser automatically |
| `--help` / `--version` | — | Prints help or version, then exits |

For example, to audit a standalone copy of Codex data:

```bash
npm start -- --app codex --root /absolute/path/to/codex-copy --no-open
```

`--root` only replaces the scan location; the classification rules still belong to the specified tool. It does not turn an arbitrary directory into a generic cleanup target. Other targets of a multi-target tool still use their default paths; tests must set a temporary `HOME` and specify a separate `--backup-dir`.

## Supported scope

| Tool | Default scan location | Session cleanup method |
|---|---|---|
| ZCode | `~/.zcode` | Deletes the target and its descendants from the body database and task index (including that session's sub-agent records, artifacts, pasted images, and command logs under `cli/`), then VACUUMs |
| Codex | `~/.codex` | Deletes the linked rows in the thread index, history projections, and logs; rollout bodies of the same thread (including paginated continuation segments) are moved to the Trash as well |
| Claude Code | `~/.claude`, `~/.claude.json` | The body is a JSONL file under `projects/`; delete per session in session management (backed up, then moved to the Trash) |
| Cursor | `~/.cursor`, `~/Library/Application Support/Cursor` | Deletes the session and blobs referenced only by that batch of sessions; supports orphan transcript backfill |
| DeepSeek Harness | `~/.dsh` | Deletes the entire session directory (including the lock) and the projection cache; the projection cache also supplies list metadata |

Tool tabs are for viewing a single tool; "All" aggregates sessions by project for lookup and browsing and offers no mixed deletion. "Security audit" scans the session bodies of each tool for credential leak patterns; it is read-only and provides no deletion entry point.

File classification is split into safe to clean, clean with caution, anomaly suggested cleaning, and do not delete. Credential, configuration, and database files are protected. Unclassified content is not recommended by default; symbolic links cannot be selected directly.

"Recommended cleanup" and "one-click cleanup" only produce a selection and confirmation list. Items can still be cancelled before execution. The default scope of session cleanup also skips recently used and pinned items; the interface is the authority on the exact scope.

## Cleanup and backup

### Session cleanup is cascading

Sessions are this tool's main subject: the list fills the full width, and opening any entry shows all of its attributes as well as **what deleting it actually takes with it** ("Contents"). Cleaning a session is not just wiping the database — the order is:

1. Back up all of this session's dedicated files on disk;
2. Delete the database rows and VACUUM;
3. Move those files to the Trash (on non-macOS this becomes "delete permanently after backup," and the result states which path was taken).

The cascade scope differs greatly between tools, and the interface lists it item by item:

| Tool | What one session cleanup takes with it |
|---|---|
| ZCode | 18 classes of table rows in two databases + `cli/{agents,artifacts,image-cache}/sess_<id>/` + `cli/rollout/model-io-sess_<id>.jsonl` + `cli/exec/sess_<id>/` |
| Codex | Every row with a thread_id across three database families + **all** rollout segments of the same thread (paginated continuation segments come along too — leaving one segment of wreckage makes recovery report a missing source rollout) |
| Claude Code | One `.jsonl` (the body is the file; there are no rows to delete) |
| Cursor | The session row in `cursorDiskKV` + exclusively owned content-pool blobs + out-of-database `agent-transcripts/<id>/`; the old text in `conversation-search.db` is maintained by Cursor itself, and this tool does not write it |
| DeepSeek Harness | The entire `session-<id>/` directory (including the lock) + the projection JSON; dangling ids in `workspace.json` are rebuilt on the next launch |

The **backup → delete database → delete files** order is deliberate: in reverse, a failed backup would produce "the session vanished from the list while not a single file was removed" — and the files are precisely the half that was never cleaned up before. If the backup does not complete, the whole batch aborts and not one database row is touched.

### Files

- **Move to Trash**: on macOS they go to `~/.Trash`; if a cross-filesystem move fails, the source files are kept and the failure is reported.
- **Delete permanently**: copy and verify the contents first, then remove the original path. Each item uses its own backup directory, stored by tool, target, and relative path; empty files can be backed up too. If the backup fails, that item is not deleted.
- Paths must lie within the target root; absolute paths, `..`, and symbolic-link traversal are not allowed. Protected content is checked recursively before deleting a directory.
- The whole batch of paths is validated first, and results are reported item by item during execution. Disk errors can leave some items succeeded and others failed; items that succeeded are removed from the current selection.

The file list lives at the bottom of the page under "Disk & other"; it is collapsed by default, with the title row showing the size and item count. Collapsed does not mean hidden — even when folded it still tells you whether it is worth expanding.

Backups also take up disk space. Moving files out of the scanned directory does not mean the disk immediately gains that much free space. Once you are sure recovery is no longer needed, manage the backups yourself.

### Databases

Formal cleanup and backfill require the target application to be fully exited. A failed process check blocks writes; read-only previews remain available.

The write order is uniform:

1. Validate the main database path and any existing WAL, SHM, and journal side files, then open all related databases and acquire write locks, checking integrity and foreign keys.
2. Copy the main database and any existing WAL/SHM/journal side files into a separate directory and verify the file contents.
3. Re-verify the targets inside a transaction and execute the SQL.
4. Check all databases, then commit database by database.
5. Cleanup operations run VACUUM, then re-check integrity.

If the SQL or the pre-commit checks fail, every uncommitted transaction is rolled back. **Multiple independent SQLite files cannot guarantee global atomicity across a power loss or a disk failure during the commit phase.** If the commit or VACUUM phase fails, the error lists the committed databases and the backup location. Stop further cleanup, verify, and restore the data first.

A single server instance accepts only one write operation at a time; overlapping requests return `409`. Do not start multiple instances operating on the same batch of files; filesystem operations cannot isolate against concurrent modification by external programs. Database locks are also no substitute for the requirement to exit the target application.

When multiple `state_*.sqlite` files exist in the Codex root, the index currently in use cannot be reliably determined, so session cleanup is not offered for now. File scanning merges the session IDs from readable indexes to avoid mislabelling bodies that still have an index as orphans.

### Restoring backups

Exit the target application and stop Inspector first. Keep a copy of the failure scene so the recovery process does not overwrite the only evidence.

- Files: use the `backup` path returned by the operation and put the copy back at the original target and relative path.
- Databases: restore the whole group of related databases from the same operation's backup. First move the current main database together with its `-wal`, `-shm`, and `-journal` into a directory kept for the scene, then copy the main database and side files from the backup; do not mix files from different batches, and do not leave old side files behind.
- After restoring, do a read-only check first, confirming the target application can read the sessions normally before continuing to use it.

`backups/` contains complete session bodies and is ignored by Git. Custom backup directories should also stay private and must not be committed to the repository.

## Cursor backfill boundaries

Backfill targets sessions where "the transcript exists but the session header is missing" and restores only the reconstructable text and tool-call summaries. It cannot reconstruct original checkpoints, tool-result blobs, or the execution environment.

When the session header cannot be read, no orphan judgment is made. Sessions that already have a header or already have a body with the same ID are skipped; writes use inserts and do not overwrite existing bodies. Backfill requires an explicit selection, an entered confirmation word, exiting Cursor, and a completed backup and database check.

Blob cleanup uses the identified text hashes, binary hashes, and tool-call ID references. Blobs referenced by unknown key families, and descendants referenced by retained blobs, are all preserved. Cursor's internal format is not a stable public protocol; when a new format appears, fixtures and recognition rules should be added before broadening the cleanup scope.

## Security audit

Answers one question: **have credentials ever leaked out of the sessions**. It reads session bodies (read-only), walks tool calls and outputs in on-disk order, and reports three levels of results:

| Level | Criterion |
|---|---|
| High risk | A sensitive file (`.env`, `id_rsa`, `credentials.json`…) was read first, and the same value later appears in an outbound call |
| Suspected | An outbound call embeds a credential pattern (AWS key, GitHub token, credentials in a URL, Bearer, etc.) |
| Info | A sensitive file was read. The content has already entered the model context — this is not something to delete, it is something you should know |

The outbound criterion differs by form: for shell, the outbound verbs and external URLs are checked; Codex's `exec` is JavaScript source, so the network-access tools and the `fetch` family are checked; WebFetch / search are outbound by nature. Local addresses do not count as an "external URL" signal, but calls such as `curl` and `fetch` are still checked as network operations; this is not proof of actual network traffic or of a successful send. Credential values come from only two sources: the read output of sensitive files, and the dump output of `printenv` / `env`.

**Evidence is always redacted.** This is a hard constraint, not decoration: the whole point of this tool is auditing credential leaks, and if it plucked credentials out and put them on the page, it would itself become a new leak surface. The page shows only masked values of the form `AKI••••QQ` plus a short window around the hit; every known value inside the window is substituted **before** truncation; before output there is a final pass that re-scans every value and every pattern in the bank and re-redacts in place on any hit.

Known boundaries:

- Cursor is not supported for now. Its bodies are scattered across content-addressed blobs, and opening the whole pool takes at least a dozen seconds — that cost is reserved for the "cleanup by session" line, where there is a definite action to pair with it.
- A single text is scanned only for the first 256 KiB, counted in UTF-8 bytes. Content beyond the window may contain credentials, and the interface marks it as an incomplete scan.
- JSONL is read up to the first 48 MiB, and lines longer than 512 KiB are skipped; DSH decompression output is capped at 96 MiB, and only the first 48 MiB is parsed. Read or decompression failures are reported separately.
- Scanning stops after a single session accumulates more than 32 MiB or 60 hits, and truncated sessions are marked in the interface.
- Pattern matching is not data-flow analysis. It does not recognize variables being rewritten, concatenated, encoded, or split across chunks in between; conversely, a fake test key written into a session is reported just the same. **What it reduces is oversight, not your judgment.**

## Scan scope and limitations

- The file list mainly reads file metadata; Codex classification additionally reads the first line of rollouts to identify paginated continuation segments and the original sessions they reference, protecting pagination dependencies.
- The session list reads databases, projection caches, or body metadata. Claude reads the start of the file; Cursor backfill scanning parses transcripts line by line.
- "Security audit" reads session bodies (the other features do not). See the previous section for its scope and boundaries.
- DeepSeek prefers the projection; when it is missing, it tries built-in zstd decompression with an output cap of 96 MiB, parsing the first 400 lines. On older Node without zstd, the session and its size are kept, and the title is reported as unavailable.
- SQLite requests read-only connections and enables `query_only`, making up for older Node's differences in supporting the `readOnly` option; when a direct open fails, a temporary copy is attempted. SQLite may maintain shared-memory side files for WAL, so no promise is made that scanning a directory leaves the filesystem completely unchanged.
- When the session database is unreadable, all files should not be inferred to be orphans. Errors and incomplete results are shown on the page.
- File sizes use base 1024; this is the logical file size and is not the same as actual space allocated by APFS, sparse-file occupancy, or immediately reclaimable space.
- The file list is cached for 15 seconds, the session list for 60 seconds, Cursor reference analysis for 10 minutes, and security audit for 10 minutes. A manual rescan refreshes them; the relevant caches are invalidated after cleanup and backfill finish.
- Upgrading different tools may change database structures or on-disk formats. Unrecognized formats require maintaining the adapter; you should not bypass errors to force cleanup.

## Development and verification

```bash
npm test
npm run check
```

`check` checks source syntax and runs the tests; it only walks the source directory and does not read `backups/`. Tests use a temporary HOME, temporary databases, and separate backup directories, and do not clean up real session data.

Tests cover classification, the session contract, path and cross-site boundaries, backup, write locks, cross-database rollback, parent-child sessions, Cursor reference preservation and backfill, credential-leak judgment and redaction invariants, as well as frontend pure functions and static interaction constraints. Static frontend tests are no substitute for verifying browser behavior.

`npm run test:ui` uses synthetic API data to check view switching, refresh, cleanup entry points, dialog focus, error feedback, and narrow screens, without connecting to the real session API. It uses macOS's Google Chrome by default; other installation locations can be pointed at via `CHROME_PATH`.

CI runs checks on Linux, macOS, and Node 22.5.0 / 22.23.4 / 24.22.1 / 26.12.1. Passing locally does not mean the remote CI has passed. Node 22.5 lacks the API required by the zstd test fixtures, so the corresponding cases are skipped.

| File | Responsibility |
|---|---|
| `server.mjs` | Local HTTP, request validation, file operations, caching, and worker scheduling |
| `lib/apps/` | Tool registration, target directories, classification, and running processes |
| `lib/scan.mjs` | File list, classification summary, and orphan determination |
| `lib/tasks*.mjs` | Session adapters for each tool and the shared return contract |
| `lib/cursor-purge.mjs` | Cursor reference analysis and deletion by session |
| `lib/cursor-recover.mjs` | Cursor transcript scanning and controlled backfill |
| `lib/audit.mjs` | Credential-leak judgment core: sensitive paths, secret patterns, outbound criteria, redaction (pure functions) |
| `lib/audit-sessions.mjs` | Session bodies of each tool → event stream → judgment |
| `lib/backup.mjs` | Separate backup directories and copy verification |
| `lib/database-write.mjs` | Database locks, transactions, backup, commit, and self-checks |
| `lib/write-guard.mjs` | Single-instance write-operation mutual exclusion |
| `lib/validation.mjs` | Session request parameter validation |
| `lib/sqlite-open.mjs`, `lib/db-worker.mjs` | Read-only connections, temporary copies, and background execution |
| `public/` | Pages, styles, browser state, and pure functions |
| `test/` | Regression tests with temporary data |

See [CONTRIBUTING.md](CONTRIBUTING.md) for maintenance conventions.

## License

[MIT](LICENSE)
