---
name: coin-expense-reconcile
description: Validate normalized coin-purchase receipts and expense candidates, build exact one-to-one reconciliation plans, and verify explicitly approved registrations. Use for coin receipt-to-expense matching; do not acquire service-specific data or perform general expense entry.
---

# Reconcile coin-purchase expenses

Match verified purchase evidence to unregistered expense candidates without
embedding source websites, screen structure, organization policy, credentials,
or account identities in this public skill.

## Provider boundary

Resolve providers from a local npm composition root by capability, never by a
hardcoded package name:

- `coin-purchase-evidence-source/v1` supplies normalized purchases and verified
  receipt files;
- `expense-candidate-source/v1` supplies relevant unregistered expense rows;
- `expense-registration-sink/v1` applies only a reviewed registration bundle
  and returns reread evidence.

Use `scripts/resolve_coin_expense_provider.mjs`. Instruction providers are
interactive: follow only their loaded private resource and submit the result
through the public validator. These capabilities must not run unattended unless
the selected provider explicitly declares that support.

Read [references/normalized-contracts.md](references/normalized-contracts.md)
when preparing input files. Inputs, receipts, plans, bundles, and results are
owner-only and must use mode 0600 storage.

## Dry run

Require complete coverage of the requested date range on both sides before any
registration. Use the transaction date from the normalized purchase evidence;
do not substitute receipt dates, download times, or timezone conversions. Match
only the same `serviceKey`, exact calendar date, and exact positive JPY amount.
Never use date tolerance, amount tolerance, text similarity, or coin count as an
expense matching key.

Run `scripts/plan_coin_expense.mjs`. The core consumes every purchase and
expense row at most once. A one-to-one date/amount group matches directly. A
duplicate group matches by stable occurrence order only when counts are equal,
every receipt is verified, and every expense has the same registration profile
and payment-source class. Otherwise the whole group remains ambiguous.

Before date/amount matching, require the expense input to prove that its
existing-registration lookup covered the exact set of purchase transaction IDs
in scope. Reserve a purchase when one destination-verified existing
registration names that exact transaction ID. A row being absent from the
unregistered-candidate list is never evidence that it was registered. Missing
transaction IDs, incomplete lookup coverage, unknown lookup IDs, or duplicate
registration evidence are blocking issues.

Report plan SHA-256, exact-match count and JPY total, already-registered count,
unmatched counts, ambiguous groups, receipt issues, and coverage blockers. Do
not expose receipt paths or account identifiers in the summary.

## Registration boundary

A reconciliation request authorizes a dry run, not an accounting registration.
After the user approves the exact plan SHA, match count, and total, reacquire or
reread both normalized inputs and run
`scripts/prepare_expense_registration.mjs`. Any changed plan stops.

Immediately before a provider submits registrations, obtain the browser/tool
confirmation required for the external write. This action-time confirmation is
required even when an earlier message requested registration. Follow
[references/registration.md](references/registration.md). The private provider
owns organization accounting policy, memo format, expense category, payment
account treatment, and service-specific UI steps. It may write only the expense
rows in the approved bundle and attach exactly the approved receipt per row.

After each attempted write, reread destination state before retrying. Never
blindly resubmit an uncertain result. Validate the provider result with
`scripts/verify_expense_registration.mjs`; only destination-verified
`registered` or `already_registered` results count as complete.

## Stop conditions

Stop without external writes on incomplete coverage, service/account mismatch,
invalid or reused receipt evidence, duplicate stable keys, ambiguous matches,
changed inputs, missing accounting decisions, authentication or CAPTCHA, an
unverified destination result, or any provider stop condition. Unmatched or
ambiguous groups do not authorize editing dates, amounts, or unrelated fields.
