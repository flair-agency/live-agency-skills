# Private workspace configuration

Keep destination topology outside the public repository in an owner-only JSON
file. A workspace profile may contain:

```json
{
  "spreadsheetId": "private-id",
  "timezone": "destination-timezone",
  "canonical": {
    "sheetId": 1,
    "title": "private-title",
    "headerRow": 1,
    "managedColumns": ["eventKey", "accountKey", "occurredAt", "amount", "recipientKey"],
    "derivedColumns": ["private-derived-column"],
    "formulaAnchors": ["private-cell-reference"]
  },
  "summary": {
    "sheetId": 2,
    "title": "private-title",
    "managedColumns": ["recipientKey", "accountKey", "amount", "firstAt", "lastAt"]
  },
  "supportSheets": {
    "staging": "private-title",
    "syncLog": "private-title",
    "identityEvidence": "private-title"
  },
  "lark": {
    "privateProjectionKey": {
      "appToken": "private-id",
      "tableId": "private-id",
      "sourceSheetId": 3,
      "backupDir": "/absolute/private/backup-directory",
      "fieldIds": {
        "recipient": "stable-field-id",
        "amount": "stable-field-id"
      },
      "keyFields": ["recipient"],
      "amountFields": ["amount"],
      "fieldTypes": {
        "recipient": { "uiType": "Text", "stripLeadingAt": true },
        "amount": { "uiType": "Number", "minimum": 0 }
      }
    }
  }
}
```

Projection entries define source sheet IDs, destination app/table IDs, stable
field IDs, composite-key fields, amount fields, expected UI types, optional text
normalization, numeric bounds, and backup locations. Resolve current field
display names from IDs at runtime. Never store field display names as durable
identifiers when stable IDs are available.

The configuration contains topology, not credentials. Credentials remain in an
approved environment or secret manager. Do not commit the configuration or any
generated snapshot, plan, commit payload, or backup.
