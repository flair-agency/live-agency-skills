# Private Lark and archive configuration

Store this JSON outside the public repository as a regular owner-only (`0600`)
file.

```json
{
  "appToken": "local-app-token",
  "creatorTableId": "local-creator-table-id",
  "tableId": "local-live-history-table-id",
  "fieldIds": {
    "start": "field-id",
    "end": "field-id",
    "creator": "field-id",
    "likes": "field-id"
  },
  "schemaExpectations": [
    {
      "fieldId": "derived-field-id",
      "type": 20,
      "formulaExpression": "organization-specific expected formula"
    }
  ],
  "archiveDestination": {
    "sharedDriveId": "shared-drive-id",
    "folderId": "folder-id",
    "mimeType": "application/gzip"
  }
}
```

The four writable field IDs must be distinct. `likes` must be numeric. The
creator field must be a single relation to `creatorTableId`. Display names are
never configured.

`schemaExpectations` is optional but recommended for every derived field whose
meaning justifies the retention policy. A configured type and compacted formula
must match the live schema before a plan is created or applied. Field display
name changes do not change the schema fingerprint.

The archive destination and expected formulas are environment-specific and
remain private. This file contains no credential secret; supply Lark credentials
through environment variables or an explicitly selected keychain item.
