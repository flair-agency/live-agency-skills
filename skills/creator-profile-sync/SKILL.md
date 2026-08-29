---
name: creator-profile-sync
description: Prepare creator targets, validate normalized follower, community, and live-session observations, and safely append new history to Lark Base. Use for reviewed profile refreshes; do not acquire service-specific observations, update existing history, or delete records.
---

# Sync creator profile observations

Append reviewed creator profile and live-session observations to Lark without
embedding knowledge of the source service. The public core owns target
selection, the normalized contract, exact reconciliation, constrained creates,
and post-write verification.

## Source boundary

Export a private target manifest from Lark. It includes stable creator record
IDs, normalized account keys, a rolling cutoff, and up to 20 known live-session
anchors per creator. It contains no source URL or UI instruction.

Obtain observations in either form:

1. normalized JSON conforming to
   [references/normalized-profile-observations.md](references/normalized-profile-observations.md); or
2. exactly one installed `creator-profile-observation-source/v1` provider
   discovered from the direct npm dependencies of a local composition root.

Use `scripts/resolve_profile_source.mjs`. If the resolver returns private
instructions, follow only those loaded instructions and validate their result
through the same normalized schema. Never add provider package names, source
URLs, UI labels, parsing rules, or device procedures to this skill.

An unattended run is allowed only when the provider manifest explicitly
declares it. Authentication or human interaction stops an unattended run.

## Target selection

`scripts/export_profile_targets.mjs` defaults to the configured due view and 20
rows. Use `--mode selected` with repeated `--account`, or `--mode all`, only
when the user explicitly requests records outside that view. The hard maximum
is 100 targets.

The exporter stops on duplicate accounts, malformed creator links, ambiguous
live timestamps, missing field IDs, wrong field types, or changed relation
targets. All manifests, observations, and plans are private owner-only files.

## Reconciliation

- Require exactly one observation for every manifest row and no extras after
  account normalization.
- Create one profile-history row only when at least one profile metric was
  observed. Leave unavailable values blank; never infer zero.
- Treat a matching profile observation already written after its observation
  timestamp as already applied.
- Identify a live session by creator, start time, and end time. Equal stored
  likes mean already applied; different likes or duplicate stored sessions are
  blocking conflicts.
- Never update or delete existing profile or live-history records.
- Omit the profile timestamp from writes so Lark supplies its configured
  automatic timestamp.

## Reviewed apply

Create a plan with `scripts/sync_profile_observations.mjs` using a manifest,
normalized observations, and `--output-plan`. Report its SHA-256, profile/live
create counts, already-applied counts, unavailable profiles, conflicts, and
target issues.

Rerun the saved plan without `--apply` immediately before mutation. Applying
requires explicit approval of the exact plan SHA-256, profile-create count, and
live-create count. Before writing, reread field definitions, creators, due-view
membership, profile history, and live history. After writing, reread until all
approved observations are accounted for.

Do not retry an uncertain batch create. Reconcile by rereading and require a new
plan and approval for any remainder.

## Destination and credentials

Use the private field-ID-only configuration in
[references/lark-config.md](references/lark-config.md). Resolve current display
names from those IDs at runtime and use only the Lark API.

Supply credentials with `LARK_TENANT_ACCESS_TOKEN`, `LARK_APP_ID` plus
`LARK_APP_SECRET`, or an explicitly selected `LARK_KEYCHAIN_SERVICE`. Never put
credentials, creator data, plans, or provider instructions in Git.
