---
name: creator-profile-compaction
description: Safely compact creator profile observation history in Lark Base while retaining oldest, latest, recent, weekly, monthly, and yearly measured records. Use for reviewed dry runs and explicitly approved deletions; do not use to collect observations or create records.
---

# Compact creator profile history

Reduce an existing Lark Base observation history without synthesizing data.
This skill is source-neutral: it does not know which service supplied follower,
post, nickname, avatar, or feature-observation values, and it does not acquire
new observations.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
The exact-approval and destructive-workflow rules below always take precedence;
import never substitutes for deletion.

## Destination configuration

Require a private local configuration described in
[references/lark-config.md](references/lark-config.md). Identify the Base,
table and profile fields by stable IDs. Resolve current display names from those
IDs at runtime. Never treat a display name as field identity.

Use `LARK_TENANT_ACCESS_TOKEN`, or `LARK_APP_ID` with `LARK_APP_SECRET`. A
macOS keychain entry can be selected with `LARK_KEYCHAIN_SERVICE`. Keep
credentials, identifiers, plans, and real records out of Git.

## Retention policy

Interpret calendar boundaries in `Asia/Tokyo`. For each creator, always retain
the oldest and latest measured record, then retain:

- every record newer than 7 days;
- a representative per calendar week from 7 through 29 days old;
- a representative per calendar month from 30 through 364 days old; and
- a representative per calendar year from 365 days onward.

The representative is the latest measured record in the bucket. If it lacks a
follower, recent-post, latest-post, nickname, avatar, or feature-observation
value, also retain the latest record in that bucket that contains the missing
value. Do not create averages, totals, or replacement records.

## Safe workflow

1. Create a private plan with `scripts/lark_profile_compact.mjs plan`.
2. Report its SHA-256, record count, keep count, deletion-candidate count,
   affected-creator count, and malformed count.
3. Run `apply` without `--apply` to reread Lark and check that the plan is not
   stale.
4. Stop if any record has an invalid ID, a non-unique creator link, an invalid
   or future timestamp, or an invalid metric. Malformed records are retained,
   but their presence blocks all deletion.
5. Delete only after the user explicitly approves both the current plan hash
   and exact deletion count.
6. Reread Lark after deletion. Confirm every deletion candidate is absent and
   every keep record remains. If a write response is uncertain, do not retry;
   rely on the reread result and report ambiguity when it cannot be resolved.

Planning and dry-run inspection are read-only. Authorization to collect or add
profile observations is not authorization to delete history, and vice versa.

## Commands

```sh
node scripts/lark_profile_compact.mjs plan \
  --config /absolute/private/lark-profile-history.json \
  --output /absolute/private/profile-compaction-plan.json

node scripts/lark_profile_compact.mjs apply \
  --config /absolute/private/lark-profile-history.json \
  --plan /absolute/private/profile-compaction-plan.json

node scripts/lark_profile_compact.mjs apply \
  --config /absolute/private/lark-profile-history.json \
  --plan /absolute/private/profile-compaction-plan.json \
  --apply --expect-sha256 PLAN_SHA256 --confirm-delete COUNT
```

## Completion report

Report the plan hash, total/keep/delete/affected/malformed/stale counts,
whether deletion was performed, and post-delete verification. Never include
credentials, private identifiers, real creator identities, or raw records in
the report.
