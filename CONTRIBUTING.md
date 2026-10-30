**English** · [简体中文](CONTRIBUTING.zh-CN.md)

# Maintenance conventions

## Data boundaries

- Tests, performance experiments, and delete verification must use a temporary HOME, a temporary scan root, and a separate backup directory. Sending test delete requests against real sessions is forbidden.
- Do not treat "the check failed" as "it does not exist" or "it can be deleted." Permission errors, process detection failures, and schema incompatibilities must all be handled explicitly.
- All database write operations go through `writeDatabases`, and all HTTP write entry points go through the write-operation mutual exclusion layer. A failed backup must not be followed by continuing.
- Do not use broad `catch` blocks to hide SQL write failures. Optional tables use explicit existence checks; structural or constraint errors in existing tables should be rolled back.
- When a SQLite query returns no result, do not judge only by the truthiness of the `.get()` return value: Node 22.5 returns an object whose fields are `null`. Check the actual fields or use `.all()[0]`.
- Backfill may only add bodies. A missing session header does not mean the body does not exist.
- Do not promise atomic commits across independent databases under power loss; errors must preserve the backup location and the committed scope.

## Modules and interface

- Keep zero third-party runtime dependencies. New dependencies require a clear benefit and alternative.
- Shared classification semantics live in `lib/apps/taxonomy.mjs`, and common rules live in `common.mjs`. Protection rules and scan display must stay consistent.
- Adapters return the session contract from `tasks-shape.mjs`; `bodyRel` must be able to match the file scan results.
- **Every adapter must export `sessionContents(root, tasks, problems)`**, returning `Map<session id, contents>`, with the shape of `emptyContents()` in `lib/session-contents.mjs`. It answers "what does deleting this session take with it," and both the "Contents" view in the interface and the size in the cleanup drawer read it — so **the preview and the actual deletion must share the same implementation**; computing it twice separately will sooner or later tell two different stories.
  - Items with `removable: false` are not deleted and must be marked truthfully (for example Cursor's search index, or the `workspace.json` record of DSH).
  - Files are listed individually (you must be able to name names when something goes wrong), and directories are combined into one entry with an item count.
  - Enumeration failures only record `problems`; do not let the entire session list fail to open.
- Session cleanup goes through `runCascade()` in `lib/cascade.mjs`; do not assemble the order yourself in routes. The discipline is **back up all files first → then delete the database → finally delete the files**: in reverse, a failed backup means "the session vanished from the list while not a single file was removed." `CONTENT_ROLES` and the frontend `CONTENT_ROLE_LABEL` are locked together bidirectionally by tests; adding a role means adding it on both sides.
- The session panel is the main body, and the file list is tucked into the `#extras` collapsed area. When changing `grid-template-areas`, update the "sessions before the extras area" invariant in `test/frontend-static` at the same time (it guards consistent reading order on wide and narrow screens).
- Files and sessions belong to two different cleanup paths. The session cascade is the only exception and must go through `runCascade`; do not stuff both batches of paths into the same request just because they look alike in the interface.
- Check the request generation and the current view before updating the interface with asynchronous results. Preserve actionable error messages on failure; partial success must be listed explicitly.
- Repeated submission is forbidden while a write operation is in progress, and entering the confirmation word must not re-enable a button that is still processing.

## Verification and delivery

- Add behavior tests that cover the failure direction when fixing data-safety or behavior defects. Avoid proving correctness only with source-code regular expressions.
- For critical regression cases, verify that they fail against the code before the fix, or inject an observable failure to prove the test can catch the problem.
- After changing an interface, verify the documentation, frontend, and fixtures; after changing interactions, verify narrow screens, the keyboard, and error states in a browser.
- Run `npm run check`. Report the local runtime environment, the actual results, and any platforms not run; do not treat a configuration existing as verification passing.
- Preserve the user's existing changes and backups. Do not automatically rewrite Git history, and do not add session data to version control.
