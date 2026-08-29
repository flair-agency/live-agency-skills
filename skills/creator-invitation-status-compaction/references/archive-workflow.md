# Archive, delete, and restore workflow

## Plan

```sh
node scripts/lark_invitation_compact.mjs plan \
  --config /absolute/private/invitation-lark.json \
  --output /absolute/private/invitation-compaction-plan.json

node scripts/lark_invitation_compact.mjs apply \
  --config /absolute/private/invitation-lark.json \
  --plan /absolute/private/invitation-compaction-plan.json
```

The second command is read-only. Stop on any blocking count or stale plan.

## Archive and receipt

```sh
node scripts/lark_invitation_compact.mjs archive \
  --config /absolute/private/invitation-lark.json \
  --plan /absolute/private/invitation-compaction-plan.json \
  --output-dir /absolute/private/archive
```

Upload the returned gzip file to the configured private Drive folder without
changing sharing. Download the entire uploaded file and calculate its SHA-256;
a preview or partial text read is insufficient.

```sh
node scripts/lark_invitation_compact.mjs receipt \
  --config /absolute/private/invitation-lark.json \
  --plan /absolute/private/invitation-compaction-plan.json \
  --archive /absolute/private/archive/ARCHIVE.json.gz \
  --output /absolute/private/invitation-archive-receipt.json \
  --drive-file-id FILE_ID \
  --drive-file-url FILE_URL \
  --drive-file-name FILE_NAME \
  --verified-file-sha256 READBACK_SHA256
```

## Delete after exact approval

```sh
node scripts/lark_invitation_compact.mjs apply \
  --config /absolute/private/invitation-lark.json \
  --plan /absolute/private/invitation-compaction-plan.json \
  --archive-receipt /absolute/private/invitation-archive-receipt.json \
  --apply \
  --expect-sha256 PLAN_SHA256 \
  --confirm-delete COUNT
```

Do not automatically resend after a write error. The command rereads Lark and
accepts an ambiguous response only when every reviewed deletion and keeper is
verified.

## Restore after separate exact approval

First inspect:

```sh
node scripts/lark_invitation_compact.mjs restore \
  --config /absolute/private/invitation-lark.json \
  --archive /absolute/private/archive/ARCHIVE.json.gz
```

Then apply only after approval of the reported archive SHA, create count, and
attachment-resume count:

```sh
node scripts/lark_invitation_compact.mjs restore \
  --config /absolute/private/invitation-lark.json \
  --archive /absolute/private/archive/ARCHIVE.json.gz \
  --apply \
  --expect-archive-sha256 ARCHIVE_SHA256 \
  --confirm-create COUNT \
  --confirm-attach COUNT
```

The restore is idempotent by semantic creator, timestamp, status, identity,
nickname, and avatar hashes. A partially created row with matching core fields
and missing avatars is resumed by attachment only; different existing content
blocks restore.
