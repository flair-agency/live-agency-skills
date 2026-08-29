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
  "projections": []
}
```

Projection entries may add source ranges, destination app/table IDs, stable
field IDs, composite-key fields, amount fields, and backup locations. Resolve
current field display names from IDs at runtime. Never store field display names
as durable identifiers when stable IDs are available.

The configuration contains topology, not credentials. Credentials remain in an
approved environment or secret manager. Do not commit the configuration or any
generated snapshot, plan, commit payload, or backup.
