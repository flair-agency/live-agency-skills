# Normalized creator public-profile observations

```json
{
  "observedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    {
      "creatorRecordId": "recSynthetic0001",
      "accountKey": "synthetic_creator",
      "observedAt": "2030-01-02T03:03:00.000Z",
      "profile": {
        "followerCount": 17000,
        "followerStatus": "observed_rounded",
        "followerDisplay": "17K",
        "recentPostCount30d": 8,
        "recentPostStatus": "observed_exact",
        "latestPostAt": "2030-01-01T12:00:00.000Z",
        "latestPostStatus": "observed_exact",
        "nickname": "Synthetic Creator",
        "nicknameStatus": "observed_exact",
        "avatar": {
          "path": "/private/runtime/avatar.png",
          "sha256": "64-lowercase-hex-characters",
          "size": 1234,
          "name": "avatar.png",
          "mimeType": "image/png"
        },
        "avatarStatus": "observed_exact",
        "featureObservationData": {
          "schema_version": 1,
          "profile": { "display_name": "Synthetic Creator" },
          "posts": { "last_30_days_count": 8 },
          "observation": { "observed_at": "2030-01-02T03:03:00.000Z" }
        },
        "featureObservationStatus": "observed_exact"
      }
    }
  ]
}
```

Rules:

- The complete target set appears exactly once; `rowCount` equals its length.
- Creator IDs and account keys remain associated with the target manifest and
  are unique after normalization.
- Counts are non-negative integers or `null`. `null` is never zero.
- Non-null text, time, avatar, and feature-observation values use
  `observed_exact`. Rounded follower values retain their display text.
- Unavailable values are `null` with `not_available`, `no_history`,
  `account_mismatch`, `authentication_required`, `blocked`, or
  `schema_changed`.
- Empty profile text remains `null`; do not emit placeholder phrases.
- Avatar paths are absolute private local files with verified metadata. Source
  URLs do not belong in the normalized contract.
- Feature-observation data is a versioned JSON object no larger than 100000
  UTF-8 bytes. Equivalent promoted values and timestamps must agree.
- Raw source payloads, cookies, signed URLs, screenshots, and account secrets do
  not belong in this format.
