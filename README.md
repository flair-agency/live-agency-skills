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

## Planned skill migrations

- Creator activity metric synchronization
- Creator invitation status maintenance

They will be added only after their service-specific acquisition logic and
organization-specific configuration have been separated from the public core.

## Development

```sh
npm install
npm test
npm run check:public
```

Tests use synthetic accounts and values only.

## License

[MIT](LICENSE). Copyright is retained; reuse is permitted without warranty.
