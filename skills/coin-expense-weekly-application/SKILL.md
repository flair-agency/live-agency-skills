---
name: coin-expense-weekly-application
description: Frozen prototype for Monday-to-Sunday coin-expense applications. Do not use for active drafts, submissions, automation, or new development unless the owner explicitly reopens the plan.
---

# Apply weekly coin expenses

## Development status: frozen

The owner froze this development plan on 2026-09-05. The official API does not
provide the application creation, update, transaction-assignment, draft-save,
approver-selection, or submission operations needed to automate the workflow
end to end. The remaining browser implementation and maintenance cost is not
currently justified by the expected operational benefit.

Do not resolve production providers, acquire live snapshots, create plans or
bundles for live data, schedule this workflow, or create, change, or submit an
expense application. Retain the source-neutral contracts, scripts, references,
and synthetic tests only as a prototype and design record.

Resume work only after an explicit owner decision supported by either a
documented official application-mutation API or a materially different
cost-benefit assessment. Until then, weekly expense applications remain a
manual operation.

The remaining sections describe the retained prototype and do not authorize
execution.

Prepare one application per ISO week without embedding source websites, screen
structure, account identities, credentials, or organization-specific labels in
this public skill.

## Provider boundary

Resolve providers by capability from the local composition root:

- `weekly-expense-application-source/v1` supplies a normalized snapshot of the
  exact week, candidate transactions, their eligibility evidence, and every
  related or same-title application;
- `weekly-expense-application-sink/v1` applies only an approved bundle and
  returns a destination-reread result.

Use `scripts/resolve_weekly_application_provider.mjs`. An instruction provider
is interactive: follow only its loaded private resources and submit normalized
data through this skill's validators. Keep requests, snapshots, plans, bundles,
and results in owner-only mode 0600 files. Read
[references/normalized-contracts.md](references/normalized-contracts.md) when
preparing those files.

The source may use an official API for reads. The sink may use a different
surface for writes when the official API lacks application mutation support.
Do not infer write support from an OAuth scope name.

## Dry run

Require an ISO week in `YYYY-Www` form. Derive its Monday-through-Sunday dates
with `scripts/plan_weekly_application.mjs`; do not substitute locale week
numbers or rolling seven-day windows.

An eligible transaction must be destination-verified and prove all of:

- its transaction date is inside the exact week;
- its configured coin-expense category matches;
- its memo contains the verified source transaction ID; and
- an attached receipt belongs to that same transaction ID.

Exclude rows lacking this evidence and report their reasons. Never repair,
register, detach, or edit an individual expense from this skill.

Reuse exactly one matching draft. Multiple matching drafts, an eligible row
assigned to another application, a matching non-draft with different
membership, or a draft containing non-eligible rows blocks all writes. When no
matching draft exists, plan a new application only if at least one eligible row
exists.

If the local date is on or before that week's Sunday, the target state is
`draft`. Only after Sunday has ended may the plan target `submitted`. A future
week is blocked. The exact expected title must end in the ISO week token; its
prefix belongs to the private application profile.

Report the plan SHA-256, ISO week and dates, reuse/create decision, target state,
eligible and excluded counts, total JPY, and blockers without exposing account
or transaction identifiers in the user summary.

## Application boundary

A dry run is not authorization to create, change, or submit an application.
After the user approves the exact plan SHA, item count, total, title, reuse/new
decision, and target state, reacquire the normalized snapshot and run
`scripts/prepare_weekly_application.mjs`. Any changed plan stops.

Immediately before the provider's earliest externally mutating step, obtain
the browser/tool action-time confirmation for the exact destination account,
week, title, application choice, item count, total, and final state. A provider
whose setup or navigation itself creates a draft must declare that step as a
write and may not enter it before confirmation.

Follow [references/application.md](references/application.md). The sink may
select only the exact expense keys in the approved bundle and must preserve all
expense fields and attachments. It may reuse the approved draft or create one
new application as directed; it must not create a second application after an
uncertain response.

Reread the destination after every write. Validate the returned result with
`scripts/verify_weekly_application.mjs`. Success requires the exact title,
exact expense-key membership, item count, JPY total, and required final state.

## Stop conditions

Stop without external writes on incomplete weekly coverage, invalid ISO-week
dates, unknown or duplicate keys, incomplete eligibility evidence, ambiguous
drafts, conflicting application membership, changed inputs, future weeks,
authentication or CAPTCHA, provider schema drift, missing approval-route
decisions, or an unverified destination result. Never blindly retry an
uncertain create, save, or submit.
