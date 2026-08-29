---
name: gift-history-sync
description: Validate normalized gift-event snapshots and safely merge them into an append-preserving master with reviewed username evidence and derived summaries. Use for snapshot imports and guarded downstream reconciliation; do not acquire service-specific exports or infer identity changes.
---

# Sync gift history

Keep a durable gift-event master while treating each source export as a partial
observation. A missing event never authorizes deletion. This public skill owns
the normalized contract, stable-key reconciliation, snapshot-order precedence,
review plans, and post-write verification. It contains no source-service schema,
account data, workbook ID, destination ID, or credential.

## Source boundary

Accept either normalized JSON conforming to
[references/normalized-gift-snapshot.md](references/normalized-gift-snapshot.md)
or exactly one installed `gift-history-snapshot-source/v1` provider discovered
from a local npm composition root. Use
`scripts/resolve_gift_source.mjs`. A provider package name is never hardcoded in
this skill.

If the provider returns private instructions, follow only the loaded resource
and submit its result to the public validator. An unattended run is allowed
only when the provider manifest explicitly declares it.

## Master input

Read the live canonical event range and successful synchronization log from the
destination immediately before planning. Convert them into the owner-only
master format in [references/master-and-plan.md](references/master-and-plan.md).
Do not rely on cached sheet IDs, populated bounds, formulas, or a previous
export.

Use `scripts/plan_gift_history.mjs` to produce a plan. The core applies these
rules:

- A newer snapshot wins only for common stable keys and may update observed
  recipient text.
- An older snapshot contributes only previously unknown stable keys. It cannot
  roll recipient text backward.
- Master-only events always survive.
- The same account and snapshot date with the same source SHA-256 is unchanged.
- The same account and date with a different source SHA-256 blocks by default.
  Use `--allow-same-date-replacement` only after the user explicitly reviews and
  approves that replacement.
- Reusing an event key with a different account, occurrence time, or amount is
  a blocking conflict.

Recipient-text differences are evidence for human review, not authority to
change a person or destination identity record.

## Reviewed commit

Report the plan SHA-256, mode, master/source/target rows and totals, additions,
recipient updates, retained master-only events, and username evidence. A
snapshot import request authorizes planning, not a destination write.

After explicit approval, reread the canonical range and synchronization log and
rebuild the current master. Run `scripts/prepare_gift_commit.mjs` with the exact
reviewed SHA, addition count, recipient-update count, and target row count. A
stale or blocked plan produces no commit payload.

Use the private workspace configuration described in
[references/workspace-config.md](references/workspace-config.md) to apply the
prepared target through the destination's supported API or connector. Stage the
entire managed event and summary ranges, verify row/key/total/formula invariants,
then commit them coherently. Clear only stale cells inside configured managed
ranges. Preserve user-owned tabs, formulas, formatting, filters, frozen rows,
and unrelated columns.

Append the synchronization-log entry only as part of the same successful
commit. After writing, reread canonical events and summaries, reconstruct the
master, and require the resulting event set and totals to equal the approved
target. Do not retry an uncertain write blindly; reread and reconcile first.

## Downstream projections

Treat account and monthly projection tables as derived data. Read projection
definitions and stable field IDs from the private workspace configuration.
Before a create, update, or delete, perform a fresh dry run and require explicit
approval of the exact target SHA and create/update/delete counts. Never apply a
projection deletion to the canonical gift-event master.

Refresh curated identity/lifecycle copies only from their reviewed authority,
never from source recipient-text evidence. Preserve timestamp precision and
stop on duplicate composite keys or changed field types.

## Private data

Normalized snapshots, master exports, plans, commit payloads, backups, and
workspace configurations are owner-only files. Never commit production events,
account identifiers, recipient identifiers, source payloads, screenshots,
destination IDs, or secrets.
