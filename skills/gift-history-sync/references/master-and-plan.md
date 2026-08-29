# Master and plan formats

The private master export is:

```json
{
  "version": 1,
  "events": [
    {
      "eventKey": "stable-key",
      "accountKey": "synthetic.sender",
      "occurredAt": "2030-01-01T12:00:00.000Z",
      "amount": "100",
      "recipientKey": "synthetic.recipient"
    }
  ],
  "syncLog": [
    {
      "accountKey": "synthetic.sender",
      "snapshotDate": "2030-01-02",
      "sourceSha256": "64 lowercase hexadecimal characters",
      "status": "success"
    }
  ]
}
```

Only successful or unchanged log entries enter the planning master. Rejected or
failed attempts may remain in the destination audit sheet but must not influence
snapshot precedence.

The plan contains its normalized snapshot, a SHA-256 of the input master,
append/update operations, retained-row counts, username evidence, complete
target events, derived summary rows, totals, and a content-bound plan SHA-256.
Plans may contain production identities and remain private.

Immediately before a destination write, export the live master again and use
`prepare_gift_commit.mjs`. It replays the reviewed plan at its original build
time; any changed master produces a different plan SHA and stops the commit.
