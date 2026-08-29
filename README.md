# live-agency-skills

Reusable Codex skills for live-streaming agency operations.

This public monorepo contains source-neutral workflows, normalized data
contracts, safety checks, and reusable scripts. Integrations that depend on an
authenticated portal, private export schema, private field mapping, or
organization-specific configuration live in separately versioned private
packages.

## Design

- A public skill depends on a versioned capability, never a provider package ID.
- Provider packages declare capabilities in `package.json` and implement the
  public contract.
- npm's dependency graph is the source of truth for installed providers.
- Resolution fails closed when zero or multiple providers match.
- Interactive providers and unattended providers are distinct. Scheduled jobs
  may use only providers that explicitly declare unattended support.
- Normalized input can bypass provider resolution when it has already been
  prepared and validated.

See [Provider architecture](docs/provider-architecture.md).

## Skills

- [`creator-activity-sync`](skills/creator-activity-sync/SKILL.md): validates
  normalized monthly metrics, performs a dry run, updates only three configured
  Lark fields when authorized, and verifies by rereading.
- [`creator-invitation-status-sync`](skills/creator-invitation-status-sync/SKILL.md):
  discovers normalized observation providers, maintains transition-based Lark
  history through reviewed plans, and keeps observation-service details private.
- [`creator-profile-sync`](skills/creator-profile-sync/SKILL.md): exports stable
  targets, validates normalized profile and live-session observations, appends
  only new Lark history, and verifies every approved write by rereading.
- [`creator-profile-compaction`](skills/creator-profile-compaction/SKILL.md):
  retains representative profile observations using stable Lark field IDs and
  requires hash-and-count approval before any deletion.
- [`creator-live-history-compaction`](skills/creator-live-history-compaction/SKILL.md):
  archives reversible session records before reviewed deletion and supports
  conflict-checked restoration.

Invitation-state compaction remains a separate planned migration because it is
destructive maintenance and requires a different approval boundary.

## Development

```sh
npm install
npm test
npm run check:public
```

Tests use synthetic accounts and values only.

## License

[MIT](LICENSE). Copyright is retained; reuse is permitted without warranty.
