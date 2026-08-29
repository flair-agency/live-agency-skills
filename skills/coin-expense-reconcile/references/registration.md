# Reviewed registration

The registration bundle contains only exact matches bound to the reviewed plan
SHA-256. The public core does not decide account names, category labels, memo
formats, tax treatment, departments, payment accounts, or other organization
policy. Those decisions belong to the private registration provider and its
owner-approved configuration.

Before the first external write:

1. reread current expense candidates and purchase evidence;
2. require the replayed plan SHA, exact-match count, and JPY total to equal the
   reviewed values;
3. resolve exactly one installed `expense-registration-sink/v1` provider;
4. inspect its private stop conditions and proposed field changes; and
5. obtain action-time confirmation for the exact destination account, item
   count, total, and attached receipt set.

For each item, the provider may edit only the approved expense row, attach
exactly its approved receipt, and apply its configured accounting profile. It
must preserve unrelated imported fields. After submission it rereads the
unregistered list or created expense state. An uncertain response is not a
reason to submit again.

The owner-only result uses:

```json
{
  "version": 1,
  "planSha256": "reviewed plan SHA-256",
  "bundleSha256": "prepared bundle SHA-256",
  "observedAt": "2030-01-04T00:02:00.000Z",
  "rowCount": 1,
  "results": [
    {
      "purchaseKey": "purchase-1",
      "expenseKey": "expense-1",
      "status": "registered",
      "destinationVerified": true
    }
  ]
}
```

Allowed statuses are `registered`, `already_registered`, `failed`, and
`uncertain`. A positive status is valid only with `destinationVerified: true`.
Keep failed or uncertain items unresolved and report the next human action.
