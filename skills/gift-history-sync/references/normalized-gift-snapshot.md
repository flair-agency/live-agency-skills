# Normalized gift-event snapshot

```json
{
  "version": 1,
  "snapshotDate": "2030-01-02",
  "observedAt": "2030-01-02T03:04:05.000Z",
  "accountKey": "synthetic.sender",
  "sourceSha256": "64 lowercase hexadecimal characters",
  "rowCount": 1,
  "events": [
    {
      "eventKey": "source-stable-event-key",
      "accountKey": "synthetic.sender",
      "occurredAt": "2030-01-01T12:00:00.000Z",
      "amount": "100",
      "recipientKey": "synthetic.recipient"
    }
  ]
}
```

Rules:

- One snapshot contains exactly one source account.
- `sourceSha256` hashes the untouched source artifact, not the normalized JSON.
- `eventKey` is opaque to the public core but must remain stable across source
  snapshots for the same event.
- Events are unique by `eventKey` and strictly ordered by occurrence time and
  then event key.
- `amount` is a canonical non-negative integer string so large totals do not
  lose precision.
- Recipient text may change across snapshots; it is observed evidence rather
  than an immutable person identifier.
- Raw source payloads, cookies, signed URLs, screenshots, and credentials do not
  belong in this format.
