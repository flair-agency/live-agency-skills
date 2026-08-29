# Normalized activity snapshot

The public core accepts only this source-neutral JSON shape:

```json
{
  "month": "2030-01",
  "sourceUpdatedAt": "2030-01-02T03:04:05.000Z",
  "rowCount": 1,
  "creators": [
    {
      "accountKey": "synthetic_creator",
      "diamonds": 100,
      "effectiveLiveDays": 2,
      "liveMinutes": 90
    }
  ]
}
```

Rules:

- `month` is `YYYY-MM`.
- `sourceUpdatedAt` is an ISO date-time describing source freshness.
- `rowCount` equals `creators.length`.
- `accountKey` is non-empty and unique after Unicode NFKC, leading `@`
  removal, trimming, and case folding.
- Metric values are non-negative integers.
- `effectiveLiveDays` cannot exceed the number of days in `month`.
- `liveMinutes` is already normalized to minutes. Source-specific time parsing
  belongs to the provider.

Provider provenance may be recorded separately for audit, but it is not a Lark
business-field update and must not alter the schema above.
