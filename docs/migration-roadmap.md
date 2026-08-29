# Custom skill migration roadmap

The repository grows in risk order. Existing installed skills remain available
until a migrated replacement passes tests and an installation cutover is
explicitly completed.

## Public, source-neutral skills

| Migration | Status | Private boundary |
| --- | --- | --- |
| Creator activity sync | Complete | Source acquisition providers and Lark configuration |
| Creator invitation status sync | Complete | Observation provider and Lark configuration |
| Creator profile compaction | Implemented | Lark identifiers and generated plans |
| Creator live-history compaction | Implemented | Lark/Drive identifiers and archives |
| Creator profile observation sync | Complete | Service-specific observation provider and Lark configuration |
| Gift-history reconciliation | Planned | Export data, workbook/Lark identifiers, and account evidence |
| Coin-expense reconciliation | Under design | Portal acquisition and organization accounting policy |

## Private provider candidates

Private providers remain independently versioned repositories. They implement a
public capability contract and are installed into a local npm composition root.

- creator-profile observation acquisition;
- gift-history export acquisition;
- coin receipt and expense-system acquisition/policy; and
- any service-specific schema, URL, screen, or authenticated workflow.

## Excluded or superseded

The legacy activity-incentive and invitation-status skills are superseded by
the source-neutral public skills. The retired questionnaire skill is outside
this repository's scope.
