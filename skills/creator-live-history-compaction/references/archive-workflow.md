# Archive and restore workflow

## Commands

```sh
node scripts/lark_live_history_compact.mjs plan \
  --config /absolute/private/live-history-lark.json \
  --output /absolute/private/live-plan.json

node scripts/lark_live_history_compact.mjs apply \
  --config /absolute/private/live-history-lark.json \
  --plan /absolute/private/live-plan.json

node scripts/lark_live_history_compact.mjs archive \
  --config /absolute/private/live-history-lark.json \
  --plan /absolute/private/live-plan.json \
  --output-dir /absolute/private/archive
```

Upload the returned gzip file to the configured folder without changing its
sharing. Read the entire uploaded file back and calculate its SHA-256. Then bind
the measured metadata to the plan:

```sh
node scripts/lark_live_history_compact.mjs receipt \
  --config /absolute/private/live-history-lark.json \
  --plan /absolute/private/live-plan.json \
  --archive /absolute/private/archive/file.json.gz \
  --output /absolute/private/archive-receipt.json \
  --drive-file-id FILE_ID \
  --drive-file-url FILE_URL \
  --drive-file-name FILE_NAME \
  --verified-file-sha256 READBACK_SHA256
```

After exact user approval:

```sh
node scripts/lark_live_history_compact.mjs apply \
  --config /absolute/private/live-history-lark.json \
  --plan /absolute/private/live-plan.json \
  --archive-receipt /absolute/private/archive-receipt.json \
  --apply --expect-sha256 PLAN_SHA256 --confirm-delete COUNT
```

Restore first runs without `--apply`. After exact user approval, add
`--apply --expect-archive-sha256 ARCHIVE_SHA256 --confirm-restore COUNT`.

## Verification requirements

- Verify folder ID, file name, MIME type, complete byte size, and readback SHA.
- Do not print archive contents in conversation.
- Do not treat a partial text preview as complete readback.
- On partial or uncertain Lark writes, never resend automatically. Rerun the
  read-only inspection to determine remaining work.
- Restored Lark record IDs are new; the archived original IDs are audit evidence
  only.
