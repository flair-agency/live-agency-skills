# Normalized contracts

## Coin-purchase evidence

```json
{
  "version": 1,
  "serviceKey": "synthetic-coin-service",
  "accountKey": "synthetic-account",
  "observedAt": "2030-01-04T00:00:00.000Z",
  "coverage": {
    "fromDate": "2030-01-01",
    "toDate": "2030-01-03",
    "complete": true
  },
  "rowCount": 1,
  "purchases": [
    {
      "purchaseKey": "purchase-1",
      "transactionDate": "2030-01-02",
      "amountJpy": 1000,
      "coinCount": 500,
      "transactionId": "source-transaction-1",
      "occurrence": 1,
      "receipt": {
        "status": "verified",
        "filePath": "/absolute/private/receipt.pdf",
        "sha256": "64 lowercase hexadecimal characters",
        "size": 1234,
        "mimeType": "application/pdf",
        "receiptDate": "2030-01-02"
      }
    }
  ]
}
```

`transactionDate` is the source transaction-history calendar date and is the
matching authority. `receiptDate` is evidence only. A non-verified receipt uses
status `unavailable` or `conflict` and omits file metadata. Rows are strictly
ordered by transaction date, JPY amount, occurrence, and stable key. Receipt
SHA-256 values may not be reused.

## Expense candidates

```json
{
  "version": 1,
  "serviceKey": "synthetic-coin-service",
  "expenseAccountKey": "synthetic-expense-account",
  "observedAt": "2030-01-04T00:01:00.000Z",
  "coverage": {
    "fromDate": "2030-01-01",
    "toDate": "2030-01-03",
    "complete": true
  },
  "rowCount": 1,
  "expenses": [
    {
      "expenseKey": "expense-1",
      "transactionDate": "2030-01-02",
      "amountJpy": 1000,
      "occurrence": 1,
      "paymentSourceKey": "synthetic-card-class",
      "registrationProfileKey": "synthetic-accounting-profile"
    }
  ]
}
```

The private expense provider includes only rows it has positively identified as
belonging to `serviceKey`. `registrationProfileKey` represents all accounting
decisions that could change the meaning of duplicate rows. Rows are strictly
ordered by date, amount, occurrence, and stable key.

Both coverage objects must cover the reviewed scope completely before a
registration bundle can be prepared. Production inputs and generated artifacts
must not be committed to source control.
