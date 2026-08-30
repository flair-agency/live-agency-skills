# Private Lark configuration

Store this JSON outside the public repository as an owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "liveTableId": "local-live-history-table-id",
  "metricTableId": "local-live-metric-table-id",
  "dueViewId": "local-due-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "creatorLatestLiveAt": "field-id",
    "creatorLiveDays30d": "field-id",
    "creatorLiveHours30d": "field-id",
    "creatorLikes30d": "field-id",
    "liveStart": "field-id",
    "liveEnd": "field-id",
    "liveCreator": "field-id",
    "liveLikes": "field-id",
    "metricTimestamp": "field-id",
    "metricCreator": "field-id",
    "metricFanClub": "field-id",
    "metricLatestLiveAt": "field-id",
    "metricLiveDays30d": "field-id",
    "metricLiveHours30d": "field-id",
    "metricLikes30d": "field-id"
  }
}
```

All field IDs must be present and distinct. Creator summary fields may be
lookups, formulas, or their underlying scalar types. LIVE and metric creator
fields must each be a single relation to `creatorTableId`. LIVE start/end and
metric timestamps must be date-time fields. Metric summary destinations must
be ordinary date-time or numeric fields so the Lark flow freezes a snapshot;
they must not be lookups or formulas.

This file contains destination identifiers, not credentials. Never commit it,
manifests, observations, or plans.
