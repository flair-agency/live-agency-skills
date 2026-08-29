# Normalized invitation observations

```json
{
  "observedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    {
      "accountKey": "synthetic_creator",
      "state": "synthetic_pending",
      "externalUserId": "fixture-123",
      "nickname": "Synthetic Creator",
      "avatar": {
        "path": "/private/runtime/avatar.png",
        "sha256": "64-lowercase-hex-characters",
        "size": 1234,
        "name": "avatar.png",
        "mimeType": "image/png"
      }
    }
  ]
}
```

Rules:

- `observedAt` is the single observation timestamp for the complete set.
- `rowCount` equals `creators.length`.
- `accountKey` is non-empty and unique after normalization.
- `state` is a non-empty, provider-normalized value. The destination must have
  an exact single-select option with the same name.
- `externalUserId` and `nickname` are optional strings. Missing remains blank;
  the account key is not a nickname substitute.
- `avatar` is optional. When present, it refers to a private local image already
  downloaded and validated by the provider. The public plan retains the content
  hash and private path, never a source URL.
- Source-specific raw status values and mapping logic are outside this schema.
