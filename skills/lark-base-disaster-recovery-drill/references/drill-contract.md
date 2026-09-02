# Recovery drill contract

A private drill profile binds one production Base alias, one backup destination,
one isolated test destination policy, and one reviewed restore route. It must
state which objects the route can restore, which require manual reconstruction,
and how the test destination is isolated and cleaned up.

The normalized successful receipt includes:

```json
{
  "version": 1,
  "status": "verified",
  "base_alias": "configured-logical-alias",
  "backup_receipt_sha256": "64-lowercase-hex",
  "restore_scope": "full-base",
  "schema_check": "matched",
  "record_count_check": "matched",
  "logical_hash_check": "matched",
  "completed_at": "RFC3339 timestamp",
  "cleanup_status": "verified",
  "receipt_sha256": "64-lowercase-hex"
}
```

Use `not-supported` rather than inventing a successful logical-hash result when
the selected route cannot reproduce one. A drill fails when a check promised by
the route does not match, any production destination is selected, or cleanup
state is uncertain.

The public report contains only logical aliases, counts, statuses, timestamps,
and content hashes. Private Base IDs, table IDs, file IDs, URLs, and restored
data remain in the protected runtime record.
