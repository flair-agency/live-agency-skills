# Private Lark configuration

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-table-id",
  "invitationStateTableId": "local-table-id",
  "dueViewId": "local-view-id",
  "fieldIds": {
    "creatorAccount": "field-id",
    "stateCreator": "field-id",
    "stateStatus": "field-id",
    "stateObservedAt": "field-id",
    "stateNickname": "field-id",
    "stateAvatar": "field-id",
    "stateExternalUserId": "field-id"
  }
}
```

All field IDs must be present and distinct. `dueViewId` is required for the
default due-only target mode. Display names are deliberately absent; resolve
them from field IDs at runtime.

Keep this organization-specific file outside the public repository. It contains
identifiers, not app credentials.
