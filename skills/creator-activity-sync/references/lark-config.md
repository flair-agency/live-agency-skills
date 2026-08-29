# Private Lark configuration

Keep the configuration outside the public repository, for example under an
ignored `private/` directory.

```json
{
  "appToken": "local-app-token",
  "tableId": "local-table-id",
  "fieldIds": {
    "month": "field-id",
    "account": "field-id",
    "diamonds": "field-id",
    "effectiveLiveDays": "field-id",
    "liveMinutes": "field-id"
  }
}
```

The five field IDs must be present and distinct. The three metric destinations
must be numeric fields. Display names are intentionally absent because users may
rename them.

The file contains identifiers, not app credentials. Supply credentials through
the environment or an explicitly selected keychain item.
