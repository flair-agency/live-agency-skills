# Private Lark configuration

Store this JSON outside the public repository as an owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "profileTableId": "local-profile-history-table-id",
  "dueViewId": "local-due-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "profileTimestamp": "field-id",
    "profileCreator": "field-id",
    "profileFollowerCount": "field-id",
    "profileRecentPostCount30d": "field-id",
    "profileLatestPostAt": "field-id",
    "profileNickname": "field-id",
    "profileAvatar": "field-id",
    "profileFeatureObservationData": "field-id"
  }
}
```

All field IDs must be present and distinct. `profileCreator` must be a single
relation to `creatorTableId`. Counts must be numeric, time fields must be
date-time or the documented automatic timestamp, nickname and feature data
must be text, and avatar must be an attachment. Display names are absent because
they may be renamed.

This file contains destination identifiers, not credentials. Never commit it,
target manifests, observations, plans, or avatar files.
