# Lark projection reconciliation

Treat each Lark projection as a replaceable copy of one reviewed spreadsheet
summary, never as the canonical gift-event master. The private workspace config
defines its source sheet, destination, composite-key fields, amount fields,
expected field types, and stable field IDs. The runtime resolves current display
names from those IDs on every run; display-name changes require no config edit.

Prepare an owner-only target in this form:

```json
{
  "version": 1,
  "projectionKey": "private-config-key",
  "source": {
    "spreadsheetId": "private-id",
    "sheetId": 1
  },
  "rowCount": 1,
  "rowsSha256": "sha256 calculated from normalized sorted rows",
  "rows": [
    {
      "recipient": "synthetic.creator",
      "account": "synthetic.sender",
      "development": 10,
      "relationship": 20,
      "scouting": 30
    }
  ]
}
```

Use `buildProjectionTarget` from `scripts/gift_projection_core.mjs` when
constructing targets in code. Reject blank or duplicate composite keys,
non-integer or negative amounts, a source identity mismatch, or a changed Lark
field type.

Preview with:

```sh
node scripts/sync_gift_projection.mjs \
  --config /absolute/private/workspace.json \
  --projection CONFIG_KEY \
  --target /absolute/private/target.json
```

Report the target SHA-256 and create/update/delete counts. Any deletion is a
projection-side removal and must be reviewed. Apply only after explicit approval:

```sh
node scripts/sync_gift_projection.mjs \
  --config /absolute/private/workspace.json \
  --projection CONFIG_KEY \
  --target /absolute/private/target.json \
  --apply \
  --expect-sha256 REVIEWED_TARGET_SHA256 \
  --confirm-create N \
  --confirm-update N \
  --confirm-delete N
```

The apply path rereads the live table, requires the reviewed counts to match,
saves an owner-only backup, writes only configured fields, deletes current-only
projection rows last, and rereads the destination for exact verification. If a
write response is uncertain, it succeeds only when the reread already equals
the approved target.
