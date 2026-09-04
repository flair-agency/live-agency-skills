# Custom skill migration roadmap

The repository grows in risk order. Existing installed skills remain available
until a migrated replacement passes tests and an installation cutover is
explicitly completed.

## Public, source-neutral skills

| Migration | Status | Private boundary |
| --- | --- | --- |
| Creator activity sync | Complete | Source acquisition providers and Lark configuration |
| Creator invitation status sync | Complete | Observation provider and Lark configuration |
| Creator profile compaction | Complete | Lark identifiers and generated plans |
| Creator live-history compaction | Complete | Lark/Drive identifiers and archives |
| Creator invitation-status compaction | Complete | Lark/Drive identifiers, avatar backups, and restore archives |
| Creator profile observation sync | Complete | Service-specific observation provider and Lark configuration |
| Creator LIVE-history and metrics sync | Complete | Service-specific LIVE provider, existing Lark summary fields/flow, and Lark configuration |
| Creator LIVE-metrics compaction | Complete | Lark identifiers and generated plans |
| Creator insight and LIVE-characteristic sync | Complete | Lark identifiers, private evidence contexts/proposals, and approved tag vocabulary |
| Lark Base backup | Public contract complete; Provider route pending | Lark export details, storage identifiers, artifacts, and receipts |
| Lark Base backup retention | Public contract complete; storage mutation pending | Storage identifiers, receipts, and exact delete plans |
| Lark Base disaster-recovery drill | Public contract complete; restore route pending | Test destination, restore implementation, artifacts, and drill receipts |
| Lark Base recurring maintenance | Planner complete; production profile pending | Record limits, cadence, backup receipts, and child plans |
| Gift-history reconciliation | Complete | Export acquisition/schema, workbook/Lark identifiers, and account evidence |
| Coin-expense reconciliation | Complete | Purchase evidence, expense candidates, service-specific registration, and organization accounting policy |
| Weekly coin-expense application | Frozen prototype; do not activate or schedule | Weekly applications remain manual; reopen only after explicit owner approval supported by official application-mutation API coverage or a materially different cost-benefit assessment |

## Private provider repositories

Private providers are independently versioned by external execution surface.
Each repository keeps implementation and source-specific knowledge together,
implements public capability bindings, and is installed into a local npm
composition root. The canonical composition root is the private
`live-agency-provider-runtime` repository, which pins reviewed revisions of
this repository and every provider repository.

| Repository | Migrated responsibilities |
| --- | --- |
| `live-agency-provider-lark-base` | Lark Base client and API/browser/import provider policy |
| `live-agency-provider-backstage` | activity export/paste and invitation observation |
| `live-agency-provider-tiktok-ios` | LIVE-history/fan-club observation and gift-history export |
| `live-agency-provider-tiktok-web` | public-profile observation and coin-purchase evidence |
| `live-agency-provider-moneyforward-cloud-expense` | Money Forward Cloud Expense candidates, accounting profile, and reviewed registration |

The former capability-specific provider repositories are retained only until
the new provider repositories are installed and verified. They must not receive
new provider knowledge after cutover.

## Required ongoing maintenance

Provider migration does not end provider maintenance. External sites, apps,
exports, APIs, and authenticated flows are expected to change. Every provider
must continuously maintain versioned interface knowledge, stop on unrecognized
drift, update synthetic tests with each reviewed profile change, and pass the
private composition-root checks before the new knowledge is used. This is a
required operating responsibility, not an optional improvement.

## Excluded or superseded

The legacy activity-incentive and invitation-status skills are superseded by
the source-neutral public skills. The retired questionnaire skill is outside
this repository's scope.
