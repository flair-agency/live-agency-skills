# Normalized weekly-application contracts

The private source provider emits one owner-only snapshot for the exact ISO
week. Service-specific labels and portal details remain in that provider.

```json
{
  "version": 1,
  "serviceKey": "synthetic-coin-service",
  "expenseAccountKey": "synthetic-expense-account",
  "applicationProfileKey": "synthetic-weekly-profile",
  "observedAt": "2030-01-07T00:00:00.000Z",
  "timeZone": "Asia/Tokyo",
  "isoWeek": "2030-W01",
  "coverage": {
    "fromDate": "2029-12-31",
    "toDate": "2030-01-06",
    "complete": true
  },
  "expectedTitle": "Synthetic coin expense 2030-W01",
  "expenseCount": 1,
  "expenses": [
    {
      "expenseKey": "expense-1",
      "transactionDate": "2030-01-02",
      "amountJpy": 1000,
      "sourceTransactionId": "source-transaction-1",
      "destinationVerified": true,
      "categoryVerified": true,
      "memoTransactionIdVerified": true,
      "receiptAttached": true,
      "receiptTransactionIdVerified": true,
      "applicationKey": null
    }
  ],
  "applicationCount": 0,
  "applications": []
}
```

`coverage` must cover the ISO week's Monday through Sunday exactly. `expenses`
contains every destination transaction in that range that the private profile
classifies as a candidate for the weekly coin-expense workflow, including rows
that fail one or more evidence checks. This prevents silent omission.

`sourceTransactionId` may be null only when no trustworthy ID can be read. The
memo and receipt verification flags must then be false. `applicationKey` is
null for an unassigned transaction; otherwise it identifies an entry in
`applications`.

`applications` contains every application referenced by an in-scope expense
and every destination application whose exact title equals `expectedTitle`.
Each entry uses:

```json
{
  "applicationKey": "application-1",
  "title": "Synthetic coin expense 2030-W01",
  "state": "draft",
  "destinationVerified": true,
  "expenseKeys": ["expense-1"]
}
```

Allowed states are `draft`, `submitted`, `approved`, `canceled`, and `rejected`.
Expense and application keys are stable destination IDs, not row positions.
The source must paginate to completion and strictly order transactions by date
and key, applications by title and key, and membership keys lexically.

## Result

The private sink returns one owner-only result:

```json
{
  "version": 1,
  "planSha256": "reviewed plan SHA-256",
  "bundleSha256": "prepared bundle SHA-256",
  "observedAt": "2030-01-07T00:02:00.000Z",
  "status": "submitted",
  "applicationKey": "application-1",
  "destinationVerified": true,
  "titleVerified": true,
  "expenseMembershipVerified": true,
  "observedExpenseKeysSha256": "64 lowercase hexadecimal characters",
  "itemCount": 1,
  "totalJpy": "1000",
  "finalState": "submitted"
}
```

Allowed statuses are `draft_saved`, `submitted`, `already_complete`, `failed`,
and `uncertain`. Positive statuses require every verification flag and exact
membership, count, total, title, and final state.
