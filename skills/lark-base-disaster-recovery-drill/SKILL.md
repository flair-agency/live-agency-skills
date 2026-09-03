---
name: lark-base-disaster-recovery-drill
description: Prove that a verified Lark Base backup can be restored into an isolated test destination and reconciled without touching production. Use for scheduled drill preparation or an explicitly approved recovery test; do not overwrite the production Base or expose restored data.
---

# Test Lark Base disaster recovery

Verify recoverability rather than merely verifying that a backup file exists.
Use only private Providers and an isolated, access-controlled test destination.

Read [references/drill-contract.md](references/drill-contract.md) before a run.

## Workflow

1. Select a content-verified backup that matches the Base instance, schema, and
   declared restore scope. Verify the complete stored artifact again.
2. Produce a dry-run describing the isolated destination, expected scope,
   record-count checks, schema checks, attachment limitations, and cleanup
   plan. A scheduled run stops here unless test creation is separately
   preauthorized. Use `scripts/drill_core.mjs` to build and content-bind this
   preflight; do not hand-wave an unverified artifact or production destination
   into a ready state.
3. Restore only into a newly created or explicitly designated non-production
   test Base. Never import into, overwrite, truncate, or repurpose production.
4. Compare table/field topology, per-table record counts, deterministic logical
   hashes where supported, formulas/relations, and documented unsupported
   objects. Do not treat a successful import dialog as verification.
5. Create a drill receipt bound to backup receipt, test destination, measured
   checks, result, and verification time.
6. Test-destination cleanup is a separate destructive operation. Require
   explicit approval or an exact preauthorized ephemeral environment; verify
   cleanup by rereading.

A recommended starting cadence is one full restore test before v2 production
cutover, after a material backup-format or restore-route change, and at least
every six months thereafter. Monthly maintenance checks only whether the drill
is due and whether the most recent receipt remains valid.

## Completion report

Report backup and drill receipt hashes, restore scope, expected/actual table and
record counts, schema and logical-hash results, unsupported objects, test
destination cleanup status, and the next due date. Never expose test or
production identifiers, URLs, creator data, restored contents, or credentials.
