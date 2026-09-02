# Private backup retention policy

Keep the organization-specific policy outside the public repository. It should
identify destinations and Bases by private stable references and include:

```json
{
  "daily_days": 90,
  "monthly_months": 24,
  "protect_pre_change_until_released": true,
  "protect_last_verified": true,
  "protect_successful_drill_sources": true
}
```

Monthly representatives are the newest verified daily backup in each retained
calendar month. A verified `pre-change` backup is not age-expired while it is
protected. A successful drill protects its exact source until another retained
backup has passed an equivalent or stronger drill.

Block a plan when it would leave no verified backup, delete an artifact whose
receipt is missing or invalid, delete a retained drill source, or rely on an
unverified upload. Invalid and orphaned objects require separate investigation;
their presence is not permission to delete them.

Retention-plan summaries may be shared. Exact object IDs and receipts stay in
owner-only runtime storage and are approved by plan hash and exact counts.
