# Normalized creator profile observations

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
        "communityCount": 123,
        "communityStatus": "observed_exact"
      },
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

- The complete target set appears exactly once; `rowCount` equals its length.
- Creator record IDs and account keys remain exactly associated with the target
  manifest. Account keys are unique after normalization.
- Every time is an ISO date-time. A live end is at or after its start and no
  more than 24 hours later.
- Counts are non-negative integers or `null`. `null` is never interpreted as
  zero.
- Observed rounded values retain their displayed source text.
- Metric statuses are `observed_exact`, `observed_rounded`, `not_available`,
  `no_history`, `account_mismatch`, `authentication_required`, `blocked`, or
  `schema_changed`.
- Scan modes are `incremental`, `reconcile-window`, or `baseline-full`.
- Stop reasons are `known-anchor`, `cutoff`, `history-end`, `no-history`, or
  `unavailable`.
- Live sessions are unique per creator by start and end time.

Raw source payloads, cookies, signed URLs, screenshots, or account secrets do
not belong in this format.
