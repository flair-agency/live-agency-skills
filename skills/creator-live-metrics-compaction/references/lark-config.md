# Private Lark configuration

Store this JSON outside the public repository as an owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "tableId": "local-live-metric-table-id",
  "fieldIds": {
    "timestamp": "field-id",
    "creator": "field-id",
    "fanClub": "field-id",
    "latestLiveAt": "field-id",
    "liveDays30d": "field-id",
    "liveHours30d": "field-id",
    "likes30d": "field-id"
  }
}
```

All field IDs must be present and distinct. `creator` must be a single relation
to `creatorTableId`. Timestamps must be date-time and metrics must be ordinary
numeric fields. Flow-populated snapshot fields must not be formulas or lookups.

The configuration contains destination identifiers, not credentials. Never
commit it, generated plans, or real Lark records.
