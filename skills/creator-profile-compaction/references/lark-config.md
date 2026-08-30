# Private Lark configuration

Store this JSON outside the public repository, normally in an ignored private
runtime directory. The file must be a regular, owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "tableId": "local-profile-history-table-id",
  "fieldIds": {
    "timestamp": "field-id",
    "creator": "field-id",
    "followerCount": "field-id",
    "recentPostCount30d": "field-id",
    "latestPostAt": "field-id",
    "nickname": "field-id",
    "avatar": "field-id",
    "featureObservationData": "field-id"
  }
}
```

All field IDs must be present and distinct. `creator` must be a single relation
to `creatorTableId`. Counts must be numeric, timestamps must be date-time,
nickname and feature-observation data must be text, and avatar must be an
attachment. Display names are absent because they can be renamed without
changing identity.

The configuration contains destination identifiers, not credentials. Never
commit it, generated plans, or real Lark records.
