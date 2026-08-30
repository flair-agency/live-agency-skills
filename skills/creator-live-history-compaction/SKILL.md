---
name: creator-live-history-compaction
description: Safely compact creator live-session history in Lark Base while preserving a rolling 30-day window and oldest/latest records, with verified archive receipts and reversible restore. Use for reviewed maintenance; do not use to acquire or add new observations.
---

# Compact creator live history

Reduce an existing Lark Base live-session history without inventing aggregate
or replacement records. The skill is source-neutral and never visits or names
the service that supplied the observations.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
The archive, exact-approval, and destructive-workflow rules below always take
precedence.

## Private configuration

Require the owner-only configuration described in
[references/lark-and-archive-config.md](references/lark-and-archive-config.md).
It identifies Lark fields and the archive destination by stable IDs. Current
field names are resolved at runtime. Optional formula expectations protect
derived metrics without embedding organization-specific formulas in this skill.

## Retention policy

Interpret dates in `Asia/Tokyo`. For each creator retain:

- the oldest and latest observed session;
- every session starting on or after the JST calendar day containing the exact
  30-day cutoff; and
- every record with a data-quality warning.

Keeping the full boundary day prevents partial-day deletion from changing
same-day duration calculations. The plan independently verifies that no record
inside the exact rolling window, or sharing a creator/day with one, is deleted.

## Destructive workflow

1. Create a private plan and inspect it against a fresh Lark read.
2. Stop on a malformed creator link/start time, metric-preservation violation,
   schema change, or stale plan.
3. Build a gzip restore archive containing only deletion candidates and only
   the writable semantic values needed for restore.
4. Upload it to the configured archive destination. Read the entire file back,
   compute SHA-256, and create a receipt from measured Drive metadata. Upload
   success or metadata alone is insufficient.
5. Delete only after the user explicitly approves the current plan SHA-256 and
   exact deletion count. Require the verified archive receipt.
6. Reread Lark and confirm every deletion candidate is absent, every keep record
   remains, and no further candidate remains for the same plan time.

Do not retry an uncertain write. Reconcile by rereading first.

## Restore workflow

Read the complete archive, verify both file and archive hashes, and dry-run it
against current Lark records. Treat creator missing, duplicate session keys, or
different like counts as blocking conflicts. Restore only after explicit
approval of the archive SHA-256 and current creation count, then reread until
every archived session is accounted for.

Detailed commands and receipt requirements are in
[references/archive-workflow.md](references/archive-workflow.md).

## Authorization boundary

Planning, archive creation, receipt creation, and restore inspection do not
authorize Lark deletion or creation. Archive upload is a separate external
write. Deletion and restore each need their own latest hash-and-count approval.
Never change sharing settings or any Lark field outside the four configured
writable restore fields.

## Completion report

Report plan/archive/receipt hashes as applicable, total/keep/delete/create,
affected-creator, warning, malformed, metric-violation, conflict, stale, and
verification counts. Do not expose private identifiers, URLs, creator
identities, raw records, or credentials.
