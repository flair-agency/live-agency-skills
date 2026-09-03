---
name: lark-base-maintenance
description: Coordinate recurring Lark Base backup coverage, record-capacity checks, reviewed history-compaction dry runs, backup retention, and disaster-recovery drill status. Use for scheduled Base maintenance preparation or an explicitly approved maintenance window; never treat a schedule as deletion approval.
---

# Coordinate Lark Base maintenance

Treat maintenance as one ordered workflow rather than unrelated scheduled
skills. Keep service-specific export, Drive, authentication, and instance
details in private Providers and profiles. This public skill consumes only
normalized receipts and summaries.

Read [references/maintenance-state.md](references/maintenance-state.md) before
building a run. For every Lark or storage operation, follow the installed
Provider policy and require an unattended-capable Binding for scheduled work.

## Recurring workflow

1. Resolve one exact Base instance and its reviewed per-table record limits.
   Never infer limits from a product-plan label.
2. Ask `lark-base-backup` to check the shared receipt set. If the current daily
   period already has a matching verified backup, reuse it. Otherwise create
   and verify one. Do not rely on a file name or lock file as identity.
3. Read current record counts and evaluate every configured table against its
   warning and critical ratios. A table without an approved compaction Skill is
   still monitored; capacity pressure becomes a review action rather than an
   invented deletion plan.
4. At least weekly, and immediately when a threshold is crossed, run the
   applicable compaction skill in dry-run mode:
   `creator-profile-compaction`, `creator-live-history-compaction`,
   `creator-live-metrics-compaction`, or
   `creator-invitation-status-compaction`.
5. Aggregate only each participant's safe summary: plan SHA-256, build time,
   total, projected, deletion-candidate, and blocking counts. Keep full plans,
   record IDs, and raw records in owner-only runtime storage.
6. At least monthly, ask `lark-base-backup-retention` for a dry-run retention
   plan. Check whether `lark-base-disaster-recovery-drill` is due.
7. Produce one maintenance plan with `scripts/maintenance_plan.mjs`. A
   scheduled run may create backups and dry-run plans, but must stop before any
   compaction, retention deletion, production restore, or test-environment
   cleanup.

The cadence values are defaults in the private profile, not universal product
facts. Capacity thresholds may bring a dry run forward but may never bypass a
retention rule or approval.

## Approved maintenance window

For each compaction selected by the user:

1. Rerun its read-only stale-plan inspection.
2. Require a full verified backup for the same Base and schema that completed
   no earlier than the compaction plan. A participant-specific restore archive
   remains mandatory when that compaction skill requires one.
3. Require explicit approval of the maintenance-plan SHA-256 and every child
   plan SHA-256 with its exact deletion count.
4. Invoke child skills one at a time. Stop the remaining mutations when any
   child reports stale state, a blocking issue, or uncertain verification.
5. Reread record counts and ask `lark-base-backup` for a verified
   post-maintenance backup. Report the actual reclaimed count; do not assume it
   equals the proposal.

Approval for one child plan does not authorize another child plan, backup
retention, restore, or test-Base deletion.

## Distributed scheduling

Every device checks the same shared, verified backup receipts before acting.
Google Drive file names are not unique, so do not implement exclusion with a
same-name lock file. Recheck shared state before upload, tolerate a rare
duplicate verified backup, and let reviewed retention handle duplicates later.

## Command

```sh
node scripts/maintenance_plan.mjs plan \
  --input /absolute/private/normalized-maintenance-state.json \
  --output /absolute/private/lark-maintenance-plan.json
```

The script is read-only. It never calls Lark, Drive, a compaction mutation, or a
restore operation.

## Completion report

Report the maintenance-plan hash, backup freshness, per-table utilization and
projected utilization, compaction review candidates, blocked participants,
retention-plan status, recovery-drill status, and next due action. Do not expose
Base, table, field, record, Drive, credential, creator, or raw-data identifiers.
