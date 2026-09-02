# Verified backup receipt

The private backup runtime stores the complete artifact and a receipt in the
same protected destination. The normalized receipt passed to public Skills has
this shape:

```json
{
  "version": 1,
  "status": "verified",
  "base_alias": "configured-logical-alias",
  "schema_sha256": "64-lowercase-hex",
  "backup_class": "daily",
  "period_key": "YYYY-MM-DD",
  "artifact_kind": "full-base-export",
  "acquisition_route": "browser-full-base-export",
  "restore_scope": "full-base",
  "artifact_bytes": 1,
  "artifact_sha256": "64-lowercase-hex",
  "completed_at": "RFC3339 timestamp",
  "verified_at": "RFC3339 timestamp",
  "receipt_sha256": "64-lowercase-hex"
}
```

`artifact_kind`, `acquisition_route`, and `restore_scope` are closed values
declared by the reviewed private backup route. A logical snapshot must not
claim full-Base recovery. For a full backup, API unavailability selects the
reviewed browser export instead of changing `artifact_kind` to a logical
snapshot.
Private storage object IDs, URLs, tenant identifiers, table IDs, and credentials
are excluded from the normalized receipt and remain in its owner-only private
counterpart.

Receipt identity is content-bound. The runtime calculates `receipt_sha256` from
canonical receipt content excluding that field. A receipt is verified only
after complete storage readback reproduces both `artifact_bytes` and
`artifact_sha256`.

Multiple verified receipts may cover the same Base and period. Select the
newest matching verified receipt for coverage and surface the others to
retention. Never pick by name alone.
