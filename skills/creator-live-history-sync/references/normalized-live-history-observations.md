# Normalized creator LIVE-history observations

```json
{
  "observedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    {
      "creatorRecordId": "recSynthetic0001",
      "accountKey": "synthetic_creator",
      "observedAt": "2030-01-02T03:03:00.000Z",
      "fanClubCount": 123,
      "fanClubStatus": "observed_exact",
      "liveScan": {
        "mode": "incremental",
        "stopReason": "known-anchor",
        "knownMatchCount": 2
      },
      "lives": [
        {
          "startAt": "2030-01-01T12:00:00.000Z",
          "endAt": "2030-01-01T13:00:00.000Z",
          "likeCount": 21400,
          "likeStatus": "observed_rounded",
          "likeDisplay": "21.4K"
        }
      ]
    }
  ]
}
```

Rules:

- The complete target set appears once; `rowCount` equals its length.
- Creator IDs and account keys remain associated with the target manifest and
  are unique after normalization.
- Counts are non-negative integers or `null`. `null` is never zero.
- Rounded values retain their displayed source text.
- Statuses are `observed_exact`, `observed_rounded`, `not_available`,
  `no_history`, `account_mismatch`, `authentication_required`, `blocked`, or
  `schema_changed`.
- Scan modes are `incremental`, `reconcile-window`, or `baseline-full`.
- Stop reasons are `known-anchor`, `cutoff`, `history-end`, `no-history`, or
  `unavailable`.
- A session end is at or after its start and no more than 24 hours later.
  Sessions are unique per creator by start and end.
- Raw source payloads, cookies, signed URLs, screenshots, and secrets do not
  belong in this format.
