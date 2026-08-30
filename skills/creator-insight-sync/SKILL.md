---
name: creator-insight-sync
description: Derive reviewed creator insights and approved LIVE-characteristic tags from the latest valid profile feature observations, augmented by LIVE metric snapshots, and safely update Lark. Use for creator evaluation refreshes; do not collect source data, generate outreach, add tag vocabulary, or overwrite from insufficient evidence.
---

# Sync creator insights and LIVE characteristics

Update the current creator assessment from evidence already stored in Lark.
Treat the latest valid non-empty `特徴観測データ` as the primary source and
the latest complete `LIVE指標` snapshot as supporting quantitative evidence.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
This skill's evidence, approval, and field restrictions remain mandatory.

## Evidence boundary

Export a private, content-bound context with
`scripts/export_insight_context.mjs`. The context contains current destination
values, approved tag names, the latest usable profile JSON, and the latest
complete LIVE metric snapshot. It contains no source-service acquisition rules.

Do not use older profile data when a newer non-empty profile JSON is malformed;
stop that creator as `invalid_profile`. A newer blank profile row does not erase
the latest usable observation, but its count remains visible for review.

## Generate proposals

Follow [references/insight-proposal-schema.md](references/insight-proposal-schema.md)
and [references/trait-policy.md](references/trait-policy.md). Create exactly one
proposal per context row and bind it to the context SHA-256.

- Base the assessment primarily on observed facts in the profile JSON.
- Use LIVE frequency, duration, recency, likes, and fan-club count only when
  present. These metrics may strengthen or qualify a conclusion, but they do
  not reveal personality or content style by themselves.
- Cite the exact profile JSON pointers and LIVE metric field names used.
- Select only tags in `approvedTraits`. Never invent or silently add a tag.
- If evidence does not support a reliable assessment, mark
  `insufficient_evidence`; do not clear or replace the current values.

## Trait scope

Tags describe comparatively durable characteristics relevant to the creator as
a LIVE creator. Exclude short-video formats such as VLog, facts already present
in LIVE history such as `LIVE経験あり`, and temporary states such as event
participation. Do not infer protected or sensitive attributes.

## Reviewed apply

Create a dry-run plan with `scripts/sync_creator_insights.mjs`. Review every
proposed assessment, tag, and evidence citation. Applying requires the exact
current plan SHA-256 and update count. Reread the same Lark records immediately
before mutation and verify both fields afterward.

Write only the configured creator assessment text and multi-select trait
fields. Never create or edit tag options, source history, profile history, LIVE
history, or LIVE metrics. Do not retry an uncertain update; reconcile by
rereading. Lark record edit history supplies the destination edit audit trail.

## Destination and credentials

Use the private field-ID-only configuration in
[references/lark-config.md](references/lark-config.md). The approved vocabulary
is read from the configured tag-table multi-select field and must exactly match
the synchronized options on the creator multi-select field.

Use the batch-update API for approved mutations. On a provider limit, use only
the shared policy's exact import/browser fallback. Keep credentials,
identifiers, contexts, proposals, plans, exports, and real creator data outside
Git.
