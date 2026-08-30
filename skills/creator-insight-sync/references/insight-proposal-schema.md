# Insight proposal contract

Use one proposal for every exported context row.

```json
{
  "version": 1,
  "inputKind": "application/vnd.live-agency.creator-insight-proposals+json",
  "ruleVersion": "creator-live-characteristics/v1",
  "contextSha256": "64-lowercase-hex",
  "generatedAt": "2030-01-31T03:04:05.000Z",
  "rowCount": 1,
  "proposals": [
    {
      "creatorRecordId": "recSynthetic001",
      "status": "proposed",
      "insight": "Observed-fact-based assessment, up to 1000 characters.",
      "traits": ["approved tag"],
      "evidence": {
        "profileRecordId": "recProfile0001",
        "liveMetricRecordId": "recMetric00001",
        "profilePaths": ["/bio", "/posts/0/caption"],
        "liveMetricFields": ["liveDays30d", "liveHours30d"],
        "confidence": "medium"
      }
    }
  ]
}
```

Profile paths are RFC 6901-style JSON pointers and must exist in the exported
feature observation. Allowed LIVE fields are `fanClub`, `latestLiveAt`,
`liveDays30d`, `liveHours30d`, and `likes30d`.

For insufficient evidence use `status: "insufficient_evidence"`, `insight:
null`, `traits: []`, and a non-empty `reason`. Do not include a replacement
assessment. An unready context must use this status.
