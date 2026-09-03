# Normalized maintenance state

Store the input and generated plan in owner-only runtime storage. Private
Providers resolve source and destination identifiers before producing this
source-neutral state.

```json
{
  "version": 1,
  "observed_at": "2026-09-03T00:00:00.000Z",
  "timezone": "Asia/Tokyo",
  "base": {
    "alias": "creator-scouting",
    "schema_sha256": "64-lowercase-hex"
  },
  "policy": {
    "backup_max_age_hours": 36,
    "compaction_interval_days": 7,
    "retention_interval_days": 30,
    "recovery_drill_interval_days": 183,
    "warning_ratio": 0.75,
    "critical_ratio": 0.9
  },
  "backup_receipts": [],
  "tables": [
    {
      "alias": "profile-history",
      "record_count": 0,
      "record_limit": 1,
      "compaction": {
        "skill": "creator-profile-compaction",
        "status": "not-run",
        "last_dry_run_at": null
      }
    }
  ],
  "retention": { "last_planned_at": null },
  "recovery_drill": { "last_successful_at": null }
}
```

Allowed compaction skills are the four history-compaction Skills named in the
maintenance Skill. `status` is `not-run`, `unchanged`, `ready`, or `blocked`.
For `ready`, include `built_at`, `plan_sha256`, `delete_candidate_count`,
`projected_record_count`, and `blocking_count: 0`. For `blocked`, include a
positive `blocking_count`. Never embed the full child plan or record IDs.

Use `"compaction": null` for a table that must be capacity-monitored but has no
approved compaction Skill. Healthy unconfigured tables require no compaction
action. A warning, critical, or exhausted unconfigured table produces a
non-mutating `review-capacity-without-compaction` action; the planner never
invents a deletion strategy.

Each backup receipt follows `lark-base-backup`'s normalized receipt contract.
The planner selects only receipts with matching Base alias and schema, verified
status, valid hashes, and nonfuture timestamps. Daily coverage requires a
`daily` receipt for the current calendar date in the configured IANA timezone;
a merely recent receipt from the previous date does not satisfy it. Duplicate
equivalent receipts are valid and counted.

Record limits and ratios are reviewed configuration. The planner never derives
them from a Lark product-plan name. A scheduled plan may request backup,
compaction dry runs, retention dry runs, or recovery-drill preflight. It never
contains a deletion or restore action.
