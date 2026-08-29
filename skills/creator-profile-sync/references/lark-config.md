# Private Lark configuration

Store this JSON outside the public repository as an owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "profileTableId": "local-profile-history-table-id",
  "liveTableId": "local-live-history-table-id",
  "dueViewId": "local-due-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "profileTimestamp": "field-id",
    "profileCreator": "field-id",
    "profileFollowerCount": "field-id",
    "profileCommunityCount": "field-id",
    "liveStart": "field-id",
    "liveEnd": "field-id",
    "liveCreator": "field-id",
    "liveLikes": "field-id"
  }
}
```

All field IDs must be present and distinct. Profile and live creator fields
must each be a single relation to `creatorTableId`. Metric destinations must be
numeric, and time fields must be date-time fields. Display names are
intentionally absent because they may be renamed.

This file contains destination identifiers, not credentials. Never commit it,
target manifests, observations, or plans.
