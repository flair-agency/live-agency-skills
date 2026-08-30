---
name: creator-live-history-sync
description: Prepare creator targets, validate normalized fan-club and live-session observations, append new LIVE history and one LIVE-metric snapshot per successful scan, and verify created records with bounded Lark reads. Use for reviewed LIVE refreshes; do not collect public-profile observations, update existing history, compact records, or infer creator traits.
---

# Sync creator LIVE history and metrics

Append reviewed LIVE sessions and point-in-time LIVE metrics without embedding
knowledge of the source service. The public core owns target selection,
normalized validation, exact reconciliation, constrained creates, and post-write
verification.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
This skill's append-only, approval, and flow-verification rules remain
mandatory.

## Source boundary

Export a private manifest containing stable creator IDs, normalized account
keys, a rolling cutoff, and known LIVE anchors. Obtain normalized observations
conforming to
[references/normalized-live-history-observations.md](references/normalized-live-history-observations.md)
or resolve exactly one installed
`creator-live-history-observation-source/v1` provider.

Use `scripts/resolve_live_history_source.mjs`. Keep provider package names,
source URLs, UI labels, parsing rules, credentials, and authenticated operation
instructions outside this public skill. An unattended run is allowed only when
the selected provider explicitly declares it.

## Target selection

`scripts/export_live_history_targets.mjs` defaults to the configured due view
and 20 rows. Use selected or all mode outside that view only when explicitly
requested. The hard maximum is 100 targets.

The exporter stops on duplicate accounts, malformed stored LIVE anchors,
missing field IDs, wrong field types, or changed relations. Private manifests,
observations, and plans remain owner-only files outside Git.

## Reconciliation

- Require one observation per target and no extras after account normalization.
- Identify a LIVE session by creator, start, and end. Equal stored likes are
  already applied; differing likes or duplicate stored sessions are conflicts.
- Leave unavailable likes and fan-club counts blank; never infer zero.
- Create at most one `LIVE指標` row per creator observation timestamp. Write
  only its timestamp, creator relation, and observed fan-club count.
- The configured Lark flow copies latest-LIVE and recent-30-day summary fields
  from the linked creator into ordinary date/number fields on the metric row.
  Those fields are snapshots, not lookups.
- Do not create a metric row when both the LIVE scan and fan-club observation
  are unavailable.
- Never update or delete existing LIVE or metric records.

## Summary and post-write checks

Before creating a metric row, reuse the preflight creator read to require a
complete calculated LIVE summary. Only when new sessions were appended, wait
once and reread the creator table once; require the latest-LIVE value to include
the new sessions. Do not poll repeatedly.

After each create phase, reread only the table changed by that phase and verify
the exact record keys and observed values. Normal sync does not poll or block on
the flow-copied metric fields. Check those fields only in an explicitly
requested audit or when a reported anomaly needs diagnosis. Never recreate an
existing metric merely because its flow fields are blank or delayed.

## Reviewed apply

Create a plan with `scripts/sync_live_history_observations.mjs`. Report the
plan SHA-256, LIVE-create count, metric-create count, already-applied counts,
unavailable metrics, and conflicts. Flow-field checks belong to a separate,
explicitly requested audit.

Rerun the saved plan without `--apply` immediately before mutation. Applying
requires explicit approval of the exact plan SHA-256 and both create counts.
Reread Lark before mutation, then reread each changed table once after its write
phase. Reuse preflight reads and avoid full-plan refreshes between phases. Do
not retry an uncertain create; reconcile from the single readback and require a
new plan for any remainder.

## Destination and credentials

Use the private field-ID-only configuration in
[references/lark-config.md](references/lark-config.md). Use batch APIs for
approved creates. On a provider limit, use only the shared policy's exact
import/browser fallback. The Lark flow remains a destination-side prerequisite.

Supply credentials through the supported environment variables or explicitly
selected keychain entry. Never commit credentials, creator data, plans, or
provider instructions.
