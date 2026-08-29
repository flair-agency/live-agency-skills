# Private Lark configuration

Store this JSON outside the public repository, normally in an ignored private
runtime directory. The file must be a regular, owner-only (`0600`) file.

```json
{
  "appToken": "local-app-token",
  "tableId": "local-profile-history-table-id",
  "fieldIds": {
    "timestamp": "field-id",
    "creator": "field-id",
    "followerCount": "field-id",
    "communityCount": "field-id"
  }
}
```

All four field IDs must be present and distinct. `followerCount` and
`communityCount` must resolve to numeric fields. Display names are intentionally
absent because they can be renamed without changing field identity.

The configuration contains destination identifiers, not credentials. Supply
credentials through environment variables or an explicitly selected macOS
keychain item. Do not commit the configuration, a generated plan, or real Lark
records.
