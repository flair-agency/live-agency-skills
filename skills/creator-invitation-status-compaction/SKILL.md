---
name: creator-invitation-status-compaction
description: Safely compact adjacent duplicate creator invitation-status history in Lark with reviewed deletion plans, readback-verified archives, and reversible restore. Use for explicit history maintenance; do not refresh or acquire statuses.
---

# Compact creator invitation-status history

Compact only redundant adjacent states in the existing Lark history. This skill
does not access an observation service, refresh statuses, send invitations, or
modify creator records.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
The archive, exact-approval, and destructive-workflow rules below always take
precedence.

## Retention semantics

- Resolve every Lark field by the stable IDs in private configuration. Field
  renames must continue to work; missing IDs, type changes, or relation drift
  stop the run.
- Group records by exactly one linked creator and order by observation timestamp
  then record ID.
- Compare exact status, external user ID, nickname, and downloaded avatar bytes.
  Ignore only record ID and observation timestamp.
- Collapse only adjacent equal records. Preserve `A → B → A` as three runs.
- Keep the newest record in each equal run and propose only the older records for
  deletion.
- Any malformed record, multiple nonblank external user IDs for one creator, or
  different content at the same timestamp blocks the entire plan.

The skill reuses the public invitation-status comparison and field bindings; it
contains no service-specific source information.

## Reviewed workflow

Use `scripts/lark_invitation_compact.mjs`. Read
[references/archive-workflow.md](references/archive-workflow.md) for exact
commands.

1. Create an owner-only plan and avatar backup. Report the plan SHA-256, live
   rows, duplicate runs, deletion count, projected rows, affected creators, and
   every blocking count. Do not reveal creator or attachment identifiers.
2. Rerun the read-only apply inspection. Any changed source or schema stops.
3. Create a self-contained gzip restore archive containing semantic record
   values and verified avatar bytes.
4. Upload it to the configured private Drive folder, read the complete file
   back, and create a receipt bound to its measured SHA-256 and destination.
5. Delete only after the user explicitly approves the exact plan SHA and delete
   count. Reread Lark after any response, verify every deletion and keeper, and
   never automatically retry an uncertain write.

## Coordinated maintenance handoff

`lark-base-maintenance` may schedule plan creation and read-only stale-plan
inspection. Return only the plan SHA-256, build time, total, projected,
deletion-candidate, and combined blocking counts; keep the full plan, avatar
backup, and record IDs private. A schedule never authorizes archive upload or
deletion.

Before coordinated deletion, require both this skill's verified row-level
restore archive and a content-verified full Base backup for the same Base and
schema that completed no earlier than the plan. Require explicit approval of
the maintenance-plan hash and this child hash/count. After verified deletion,
return the measured remaining count for the post-maintenance backup.

Deletion authorization does not authorize restore. Restore first runs as a dry
run and reports archive SHA-256, create count, attachment-resume count, and
conflicts. Applying restore requires separate exact approval. Restored record
IDs may differ; semantic values and avatar bytes must verify by rereading.

## Boundaries

- Compaction is never part of invitation-status refresh and must not run as an
  unattended deletion. A schedule may prepare a dry run only.
- Plans, avatar backups, archives, receipts, and configs are private and require
  owner-only storage. Never commit or publish them.
- Do not delete without a readback-verified archive receipt. Do not restore when
  creators are missing, timestamps conflict, live records are malformed, or
  existing avatar content differs.
- Prefer batch APIs for approved delete or restore mutations. On a provider
  limit, browser fallback is allowed only for the exact reviewed record IDs;
  import never substitutes for deletion. Credentials come from the configured
  environment or keychain service and must never appear in output.
