---
name: creator-live-metrics-compaction
description: Safely compact creator LIVE-metric snapshot history in Lark Base while retaining oldest, latest, recent, weekly, monthly, yearly, and incomplete-metric representatives. Use for reviewed dry runs and explicitly approved deletions; do not collect metrics, update records, or compact individual LIVE sessions.
---

# Compact creator LIVE metrics

Reduce existing `LIVE指標` history without synthesizing or changing data. This
skill is source-neutral and performs no observation, aggregation, record
creation, or record update. Its only mutation is deletion of exact reviewed
record IDs.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
The exact-approval and destructive-workflow rules below always take precedence;
import never substitutes for deletion.

## Destination configuration

Require the private field-ID-only configuration in
[references/lark-config.md](references/lark-config.md). Resolve current display
names and types at runtime. Verify the creator field remains a single relation
to the configured creator table.

Use the supported Lark credential environment or explicitly selected keychain
entry. Keep credentials, identifiers, plans, and real records out of Git.

## Retention policy

Interpret calendar boundaries in `Asia/Tokyo`. For each creator, always retain
the oldest and latest measured record, then retain:

- every record newer than 7 days;
- a representative per calendar week from 7 through 29 days old;
- a representative per calendar month from 30 through 364 days old; and
- a representative per calendar year from 365 days onward.

The representative is the latest record in the bucket. If it lacks a fan-club,
latest-LIVE, recent-30-day LIVE-day, LIVE-hour, or likes value, also retain the
latest record in that bucket containing the missing metric. Do not create
averages, totals, or replacement records.

## Safe workflow

1. Create a private plan with `scripts/lark_live_metrics_compact.mjs plan`.
2. Report its SHA-256, total, keep, delete-candidate, affected-creator, and
   malformed counts.
3. Rerun the saved plan without `--apply` immediately before mutation.
4. Retain malformed rows and block all deletion when record identity, creator
   relation, timestamp, or a present metric is invalid.
5. Delete only after explicit approval of the current plan hash and exact
   deletion count.
6. Reread Lark and verify every delete candidate is absent and every keep
   record remains. Do not retry an uncertain delete response.

Planning and dry-run inspection are read-only. Authorization to collect LIVE
metrics is not authorization to delete them, and vice versa.

## Completion report

Report the plan hash, total/keep/delete/affected/malformed/stale counts, whether
deletion occurred, and post-delete verification. Never expose credentials,
private identifiers, creator identities, or raw records.
