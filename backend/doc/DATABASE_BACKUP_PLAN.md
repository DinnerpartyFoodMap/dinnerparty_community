# SQLite OSS Backup Implementation Plan

> **For agentic workers:** Use the approved in-chat design and implement the tasks below with test-first verification. The user approved execution on 2026-10-15.

**Goal:** Back up the live SQLite database to a separate private OSS bucket without depending on the HTTP process.

**Architecture:** A standalone CLI uses a read-only source connection and SQLite's backup API, verifies the snapshot, then compresses and uploads it. Windows Task Scheduler runs the CLI every six hours; separate backup configuration never falls back to image-storage credentials.

**Tech Stack:** Existing Node.js, better-sqlite3, sqlite-vec, ali-oss, dotenv, Windows PowerShell.

**Spec:** The user-approved design in this conversation: consistent snapshots, integrity checks and SHA-256, private independent OSS configuration, unique dated objects, upload retry and verification, three successful local copies, thirty-day OSS lifecycle configured separately, and a documented restore drill.

## Global constraints

- Do not open the working database, read real credentials, contact real OSS, or register a system task during implementation tests.
- Resolve DB_FILE and BACKUP_DIR relative to backend/, independently of cwd. Never initialize or migrate the source database.
- Default CLI uploads; --local-only requires no OSS credentials and makes no network calls. --help loads no environment file or database.
- Upload gzip first, then the manifest as a completion marker. Verify both objects with HEAD. Failures return nonzero and preserve recovery artifacts.
- Keep the latest three successfully uploaded local jobs; preserve failed and local-only jobs. Never delete cloud objects or change lifecycle rules.
- A dedicated SQLite control file in the backup directory provides process-safe exclusion and crash-released OS locks; the business database has no long write transaction.
- PowerShell source stays ASCII-only. No new runtime dependencies or automatic production restore.

## Review focus

- Wrong/missing source paths must fail without creating an empty database.
- Live WAL writes and sqlite-vec virtual tables must survive a backup/restore round trip.
- Failed or incomplete uploads must never trigger retention or appear complete.
- Concurrent runs and hard exits must not leave a permanent blocking lock.
- Retention must not delete unrelated files, failed jobs, symlinks, or the source database.

## Tasks

### 1. Snapshot and upload pipeline

Files: infrastructure/databaseBackup.js; scripts/backups/backup_database.js; tests/infrastructure/test_database_backup.js.

Interfaces: readBackupConfig(env, {localOnly}) returns validated source, local retention and independent OSS options; backupDatabase(config, {client}) returns local artifact paths, hashes and verified object keys. The injectable client is only the OSS boundary.

- [x] Write failing tests for configuration, missing source, live WAL snapshot/restore, vector tables, private uploads, retries, verification failures, retention and concurrent execution.
- [x] Run the tests and observe the missing-feature failure.
- [x] Implement the module and CLI, then run the tests to green.

### 2. Scheduled execution

Files: ../script/install-database-backup-task.ps1; tests/infrastructure/test_backup_task.js.

- [x] Test task registration with mocked ScheduledTasks commands; no real tasks are registered.
- [x] Implement an independent six-hour task with absolute paths, explicit working directory, SYSTEM identity, IgnoreNew, missed-run recovery, retry and a thirty-minute limit.
- [x] Verify parser, WhatIf, uninstall and argument/path handling.

### 3. Configuration and operations

Files: .env.example; package.json; ../.gitignore; scripts/doc/README.md; infrastructure/doc/README.md; infrastructure/doc/DATABASE_BACKUP.md.

- [x] Add independent BACKUP_OSS_* settings, npm entry points and ignored local backup artifacts.
- [x] Document local rehearsal, upload, scheduling, least-privilege access, lifecycle and an isolated restore drill.
- [x] Review all commands and documentation links against implemented interfaces.

### 4. Integration verification

- [x] Run new tests, static structure checks and the full non-browser backend suite; distinguish sandbox network restrictions from product failures.
- [x] Obtain an independent code review and address actionable defects with regression tests.
- [x] Record actual test results and remaining production configuration steps.

## Progress

- Baseline: the sandbox blocks some existing loopback HTTP tests with EACCES; no product files changed before this baseline run.
- Execution: core pipeline in the main agent; scheduler and operations documentation delegated to independent agents with disjoint file ownership.
- Verification: 26/26 backend test files passed in the permitted local-test environment, including 11 pipeline cases and 19 isolated task scenarios. Structure checks and all four new JavaScript syntax checks passed.
- Review: the independent reviewer identified missing persistent logging for early environment-file errors. The CLI now logs and flushes those errors; subprocess regressions cover denied environment-file reads and missing explicit configuration.
- Implementation decisions: normalize only the completed snapshot to DELETE journal mode; use an independent control database for crash-safe exclusion; send Content-MD5 for server-side transport validation and verify downloaded SHA-256 during restore; name the explicit environment-file option --config to avoid Node's built-in --env-file pre-parser.
- Deployment validation (2026-10-15): the user supplied backup configuration. One manual backup completed successfully; the archive is 12,743,097 bytes, local SHA-256 and remote HEAD checks passed, and OSS reports storage class IA. No test objects were uploaded and no remote objects or lifecycle rules were deleted or changed.
- Environment correction: this workspace is not production. The newly registered YuyukoFoodMapDatabaseBackup task was removed immediately at the user's request, and a fresh Windows task query confirmed Exists=false. Leave this machine unscheduled; confirm the actual production host before any future task installation. Keep the uploaded objects as requested.
- Installer regression: Windows PowerShell -File resolves parameter defaults before PSScriptRoot is ready. BackendDir now resolves after the parameter block; real -File -WhatIf and 21 isolated task scenarios pass, followed by another 26/26 backend suite.
