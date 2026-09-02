---
name: lark-base-backup
description: Check shared backup coverage and create a content-verified Lark Base backup through reviewed private Lark and storage Providers. Use for scheduled daily coverage, pre-change protection, or post-maintenance snapshots; do not confuse audit logs or compaction archives with a Base backup.
---

# Back up a Lark Base

Create a recoverable Base artifact outside Lark and prove that the stored bytes
can be read back. Keep acquisition routes, Drive details, identifiers,
credentials, and production data in private Providers and runtime profiles.

Read [references/backup-receipt.md](references/backup-receipt.md) before a run.

## Workflow

1. Resolve one exact Base instance, one exact destination profile, and one
   reviewed backup route. For a requested full Base backup, require a native
   full-Base export. Use the Provider's reviewed API export when available;
   otherwise use its reviewed authenticated-browser export. Do not silently
   downgrade a full backup to API record reads or a logical data snapshot. A
   logical snapshot is allowed only when the requested backup class and restore
   contract explicitly call for that narrower artifact.
2. Query the shared receipt set for the same Base, schema fingerprint, backup
   class, and time period. Reuse a matching verified receipt.
3. If coverage is absent, recheck immediately before acquisition. Do not use a
   same-name Drive file as a lock; Drive names are not unique.
4. Acquire the artifact through the Lark Provider. A browser route may use an
   already authenticated, unattended-capable session only when its private
   Binding authorizes that execution. Authentication, CAPTCHA, an unknown UI,
   an ambiguous download, or a mismatched Base stops the acquisition. Stop if
   the selected route is unsupported or its artifact structure is unrecognized.
5. Upload to the exact private storage destination without changing sharing.
   The production profile may point to the organization's `Logs` shared drive;
   the public skill stores only the logical destination reference.
6. Download the complete stored object, verify byte length and SHA-256, and
   create a receipt bound to source, destination, artifact, schema, period, and
   restore scope. A preview, upload response, audit log, or metadata-only check
   is insufficient.
7. Requery shared receipts. If a concurrent runner created an equivalent
   backup, keep both as valid evidence and surface the duplicate to retention;
   never delete it implicitly.

Scheduled execution is allowed only for an unattended-capable read source and
an exact preauthorized destination. A schedule may create a backup because that
is the declared task, but it may not change sharing, delete older backups, or
restore anything.

## Backup classes

- `daily`: normal recovery point for the configured calendar period.
- `pre-change`: protected snapshot immediately before a reviewed destructive
  maintenance window or migration.
- `post-change`: verified state after the approved mutation and readback.
- `drill-source`: a verified backup selected for recovery testing.

Compaction-specific restore archives remain separate. They can restore exact
deleted rows but do not replace a full Base backup.

## Completion report

Report whether the run reused or created coverage, backup class, period,
artifact kind, acquisition route class, restore scope, byte count, artifact
SHA-256, receipt SHA-256, verification time, and any duplicate-equivalent
count. Never expose private identifiers, URLs, file contents, record data, or
credentials.
