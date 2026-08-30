---
name: creator-invitation-status-sync
description: Prepare targets from Lark, validate normalized creator invitation-status observations, and maintain transition-based status history with reviewed dry runs. Use for status refreshes; do not use to acquire service-specific observations, send invitations, follow accounts, or compact history.
---

# Sync creator invitation status

Maintain transition-based invitation-status history in Lark without embedding
knowledge of the observation service. The public core knows only a versioned
normalized observation contract and Lark field IDs supplied by private local
configuration.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
This skill's transition, approval, and avatar rules remain mandatory.

## Source boundary

Prepare the requested creator accounts from Lark, then obtain observations in
one of two ways:

1. accept normalized JSON conforming to
   [references/normalized-observation-schema.md](references/normalized-observation-schema.md); or
2. resolve exactly one installed `creator-invitation-observation-source/v1`
   provider from the direct npm dependencies of a local composition root.

Run `scripts/resolve_invitation_source.mjs` for a module provider. If the
resolver returns a private instruction provider, follow only those loaded
instructions and submit their result through the same normalized validator.
Never add provider package IDs, source URLs, UI labels, response codes, parsing
rules, or provider batch limits to this skill.

For unattended runs, continue only when the provider manifest declares
`unattended: true`. Authentication or human-interaction requirements stop an
unattended run rather than being bypassed.

## Refresh semantics

- Match every requested account exactly once after Unicode NFKC, leading `@`
  removal, trimming, and case folding. Reject missing, extra, or duplicate rows.
- Treat the observation `state` as an opaque normalized value. At runtime,
  require an exact option with that name in the configured Lark state field.
- Compare creator, exact state, external user ID, nickname, and avatar content.
  Ignore only the stored record ID and observation timestamp.
- When the newest stored state is identical, update only its timestamp.
- When the state differs, append one new state record.
- A nonblank observed external user ID conflicting with a nonblank historical ID
  for the creator is a stopping condition.
- Different states at the same latest timestamp are ambiguous and stop the run.
- Never update a historical state's content to make it match a new observation.

## Safety and authorization

Create a private dry-run plan and report its SHA-256, create count, timestamp
update count, avatar attachment count, already-applied count, conflicts, and
stale rows. Applying requires the user's explicit update authorization and exact
confirmation of the reviewed hash and counts immediately before mutation.

Before apply, reread creator accounts, due-view membership when applicable,
field definitions, status options, history, and avatar bytes. After apply,
reread again and require every observation to be already represented.

Do not send invitations, follow accounts, modify creator records, delete history,
or change fields other than creating an invitation-state row, extending the
latest identical row's timestamp, and attaching its observed avatar. History
compaction belongs to a separate explicit maintenance skill and is never part of
a scheduled refresh.

Use a private owner-only directory for target manifests, normalized
observations, avatar files, and plans. They contain creator identifiers. Never
commit or publish them.

Use these deterministic helpers:

- `scripts/export_invitation_targets.mjs --config CONFIG.json --output TARGETS.json`
- `scripts/resolve_invitation_source.mjs --provider-root ROOT --request REQUEST.json --output OBSERVATIONS.json`
- `scripts/sync_invitation_observations.mjs --config CONFIG.json --manifest TARGETS.json --observations OBSERVATIONS.json --output-plan PLAN.json`
- after explicit approval, `scripts/sync_invitation_observations.mjs --config CONFIG.json --plan PLAN.json --apply --expect-sha256 HASH --confirm-create N --confirm-update N --confirm-attach N`

The target exporter defaults to the configured due view. Use `--mode selected`
with repeated `--account` or `--mode all` only when the user explicitly asks to
refresh records regardless of the due view.

## Destination and credentials

Read [references/lark-config.md](references/lark-config.md) for the private
field-ID-only configuration. Resolve current field names from IDs at runtime.
Use batch APIs for approved creates and updates. On a provider limit, use only
the shared policy's exact import/browser fallback.

Use `LARK_TENANT_ACCESS_TOKEN`, `LARK_APP_ID` plus `LARK_APP_SECRET`, or an
explicit `LARK_KEYCHAIN_SERVICE`. Never put credential values in plans,
configuration, logs, or Git.
