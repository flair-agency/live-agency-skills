# live-agency-skills

Reusable Codex skills for live-streaming agency operations.

This public monorepo contains source-neutral workflows, normalized data
contracts, safety checks, and reusable scripts. Integrations that depend on an
authenticated portal, private export schema, private field mapping, or
organization-specific configuration live in separately versioned private
packages.

## Design

- A public skill depends on a versioned capability, never a provider package ID.
- Provider repositories keep one external surface's implementation and
  versioned knowledge together. Their packages may declare multiple capability
  bindings in `package.json`.
- npm's dependency graph is the source of truth for installed providers.
- Resolution fails closed when zero or multiple providers match.
- Interactive providers and unattended providers are distinct. Scheduled jobs
  may use only providers that explicitly declare unattended support.
- Normalized input can bypass provider resolution when it has already been
  prepared and validated.
- Provider resolution records package version, binding ID, and knowledge
  version for audit.

See [Provider architecture](docs/provider-architecture.md).

## Skills

- [`creator-activity-sync`](skills/creator-activity-sync/SKILL.md): validates
  normalized monthly metrics, performs a dry run, updates only three configured
  Lark fields when authorized, and verifies by rereading.
- [`creator-invitation-status-sync`](skills/creator-invitation-status-sync/SKILL.md):
  discovers normalized observation providers, maintains transition-based Lark
  history through reviewed plans, and keeps observation-service details private.
- [`creator-profile-sync`](skills/creator-profile-sync/SKILL.md): exports stable
  targets, validates normalized public-profile observations, appends follower,
  recent-post, nickname, avatar, and feature-observation history, and verifies
  every approved write by rereading.
- [`creator-live-history-sync`](skills/creator-live-history-sync/SKILL.md):
  validates fan-club and LIVE-session observations, appends new LIVE history,
  creates one `LIVE指標` snapshot per scan, and verifies the existing Lark flow.
- [`creator-insight-sync`](skills/creator-insight-sync/SKILL.md): derives
  reviewed current assessments and approved LIVE-characteristic tags from the
  latest profile evidence with LIVE metrics as supporting evidence.
- [`creator-profile-compaction`](skills/creator-profile-compaction/SKILL.md):
  retains representative profile observations using stable Lark field IDs and
  requires hash-and-count approval before any deletion.
- [`creator-live-metrics-compaction`](skills/creator-live-metrics-compaction/SKILL.md):
  applies the same representative retention policy to `LIVE指標` snapshots.
- [`creator-live-history-compaction`](skills/creator-live-history-compaction/SKILL.md):
  archives reversible session records before reviewed deletion and supports
  conflict-checked restoration.
- [`creator-invitation-status-compaction`](skills/creator-invitation-status-compaction/SKILL.md):
  compacts only adjacent duplicate invitation states after a verified archive
  and supports semantic, avatar-preserving restoration.
- [`lark-base-backup`](skills/lark-base-backup/SKILL.md): checks shared receipt
  coverage and creates a full-readback-verified Base backup through private
  Lark and storage Providers.
- [`lark-base-backup-retention`](skills/lark-base-backup-retention/SKILL.md):
  prepares reviewed retention plans without unattended backup deletion.
- [`lark-base-disaster-recovery-drill`](skills/lark-base-disaster-recovery-drill/SKILL.md):
  verifies restore into an isolated test destination without touching production.
- [`lark-base-maintenance`](skills/lark-base-maintenance/SKILL.md): coordinates
  backup coverage, per-table capacity, compaction dry runs, retention, and
  recovery-drill status while keeping destructive work explicitly approved.
- [`gift-history-sync`](skills/gift-history-sync/SKILL.md): validates normalized
  partial gift snapshots, preserves omitted master events, records recipient
  evidence, and prepares content-bound reviewed commits and projections.
- [`coin-expense-reconcile`](skills/coin-expense-reconcile/SKILL.md): validates
  normalized purchase receipts and expense candidates, builds exact one-to-one
  plans, and verifies only explicitly approved registrations.

## Development

```sh
npm install
npm test
npm run check:public
```

Tests use synthetic accounts and values only.

## License

[MIT](LICENSE). Copyright is retained; reuse is permitted without warranty.
