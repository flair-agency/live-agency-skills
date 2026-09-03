---
name: lark-base-backup-retention
description: Build and verify a reviewed retention plan for content-verified Lark Base backups in shared storage. Use to retain daily, monthly, protected, and recovery-tested generations or remove reviewed duplicates; never delete the last recoverable copy or run unattended deletion.
---

# Retain Lark Base backups

Reduce verified backup storage without weakening recovery. This skill consumes
backup receipts, not file names, and never reads production record contents.

Read [references/retention-policy.md](references/retention-policy.md) before
planning.

## Safe workflow

1. List complete artifacts and receipts from the exact private destination.
   Classify orphan files, orphan receipts, invalid receipts, and verified pairs.
2. Apply the private retention policy by Base instance and backup class. Always
   keep the newest verified backup, every protected `pre-change` backup until a
   reviewed release, and every backup referenced by a retained successful
   recovery-drill receipt.
3. Treat equivalent concurrent backups as ordinary verified generations. A
   duplicate name is not evidence of duplicate content; compare receipt scope,
   period, schema, artifact kind, and SHA-256.
4. Normalize the private listing and run `scripts/retention_plan.mjs`. It
   produces a content-bound plan containing exact storage object references,
   plan SHA-256, keep/delete counts, bytes proposed, and every blocking issue.
   Never select generations by name or modification time. Keep the plan
   owner-only.
5. A schedule may create and publish the dry-run summary only. Delete only
   after explicit approval of the current plan SHA-256, exact object count, and
   byte count.
6. Before deletion, reread all candidates and keepers. Stop on drift. After the
   response, reread again; never retry an uncertain delete blindly.

Suggested starting policy is daily generations for 90 days and monthly
generations for 24 months for Scouting, and daily generations for 35 days and
monthly generations for 12 months for Management. These values belong to the
private policy and may be changed without changing this skill.

## Build a dry-run plan

```bash
node scripts/retention_plan.mjs plan \
  --input /absolute/private/normalized-retention-state.json \
  --output /absolute/private/lark-backup-retention-plan.json
```

This command only writes an owner-only dry-run plan. It does not call Google
Drive and cannot delete storage objects. A separate reviewed execution must
revalidate the current plan and receive explicit approval.

## Completion report

Report the plan hash, verified/invalid/orphan/protected/drill-referenced counts,
keep/delete counts, bytes proposed or actually reclaimed, stale state, and
post-delete verification. Do not expose object IDs, folder IDs, URLs, source
records, or credentials.
