# Private backup retention policy

Keep the organization-specific policy outside the public repository. It should
identify destinations and Bases by private stable references and include:

```json
{
  "daily_days": 90,
  "monthly_months": 24,
  "protect_pre_change_until_released": true,
  "protect_last_verified": true,
  "protect_successful_drill_sources": true
}
```

Monthly representatives are the newest verified daily backup in each retained
calendar month. A verified `pre-change` backup is not age-expired while it is
protected. A successful drill protects its exact source until another retained
backup has passed an equivalent or stronger drill.

Block a plan when it would leave no verified backup, delete an artifact whose
receipt is missing or invalid, delete a retained drill source, or rely on an
unverified upload. Invalid and orphaned objects require separate investigation;
their presence is not permission to delete them.

Retention-plan summaries may be shared. Exact object IDs and receipts stay in
owner-only runtime storage and are approved by plan hash and exact counts.

## Normalized private input

The planner consumes a private state document. The storage Provider must build
`verified_pairs` from complete artifact/receipt pairs after rereading and
validating each receipt. It must classify unresolved objects separately.

```json
{
  "version": 1,
  "observed_at": "RFC3339 timestamp",
  "timezone": "IANA timezone",
  "base_alias": "configured-logical-alias",
  "policy": {
    "daily_days": 90,
    "monthly_months": 24,
    "protect_pre_change_until_released": true,
    "protect_last_verified": true,
    "protect_successful_drill_sources": true
  },
  "verified_pairs": [
    {
      "artifact_object_ref": "private stable reference",
      "receipt_object_ref": "private stable reference",
      "artifact_bytes": 1,
      "receipt_bytes": 1,
      "pre_change_released": false,
      "successful_drill_referenced": false,
      "receipt": { "...": "normalized verified backup receipt fields" }
    }
  ],
  "orphans": [
    { "object_ref": "private stable reference", "bytes": 1, "kind": "artifact" }
  ],
  "invalid_receipts": [
    { "object_ref": "private stable reference", "bytes": 1, "kind": "receipt" }
  ]
}
```

Every object reference must be unique across all classifications. Artifact byte
counts must match their verified receipts. Receipt hashes are recomputed before
planning. Any orphan or invalid receipt blocks deletion review and is never
silently promoted to a deletion candidate.
