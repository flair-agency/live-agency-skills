# Provider architecture

## Repository boundary

Public skills own validation, matching, dry runs, content-bound write intents,
post-write result validation, and audit output. They accept normalized data and
do not know which provider package produced it. A public skill may perform a
source-neutral destination write itself or delegate a service-specific write to
a sink capability without learning the provider package name.

Private providers own source recognition, source-specific parsing or
observation instructions, schema-change detection, and normalization.
Provider-specific implementation and provider knowledge live together in one
private repository per independent external execution surface. One repository
may expose several capability bindings with different inputs or execution
kinds.

Production data and secrets are neither public-skill resources nor provider
source files. They remain in approved runtime storage and secret managers.

The current provider repositories are:

| Repository | Surface | Capability families |
| --- | --- | --- |
| `live-agency-provider-lark-base` | Lark Base API/browser/import | destination transport and Lark provider policy |
| `live-agency-provider-backstage` | TikTok LIVE BackStage | activity exports/dashboard and invitation observation |
| `live-agency-provider-tiktok-ios` | TikTok iPhone | LIVE-history observation and gift-history export |
| `live-agency-provider-tiktok-web` | TikTok Web | public-profile observation and coin-purchase evidence |
| `live-agency-provider-moneyforward-cloud-expense` | Money Forward Cloud Expense | expense candidates and reviewed registration |

TikTok iPhone, TikTok Web, and BackStage are separate providers even though
they belong to one product family. They have different authentication state,
interaction tools, schemas, release cadence, and stopping evidence.

## Capability contract

The first capabilities are:

- `creator-activity-source/v1`
- `creator-invitation-observation-source/v1`
- `creator-profile-observation-source/v2`
- `creator-live-history-observation-source/v1`
- `gift-history-snapshot-source/v1`
- `coin-purchase-evidence-source/v1`
- `expense-candidate-source/v1`
- `expense-registration-sink/v1`

A legacy single-binding provider declares one or more capabilities directly
under a schema-version-1 `liveAgencyProvider` manifest. A provider repository
that owns several capability or execution surfaces uses schema version 2 and a
stable binding ID for each surface:

```json
{
  "peerDependencies": {
    "@live-agency-skills/source-provider-api": "^1.6.0"
  },
  "liveAgencyProvider": {
    "schemaVersion": 2,
    "bindings": [
      {
        "id": "activity-export",
        "provides": ["creator-activity-source/v1"],
        "inputKinds": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        "unattended": true,
        "knowledgeVersion": "surface-profile/2026-08-30.1",
        "execution": {
          "kind": "module",
          "entry": "./src/activity-export.js"
        }
      }
    ]
  }
}
```

The private `live-agency-provider-runtime` repository is the canonical
composition root. It pins this repository and each private provider repository
at reviewed commits, and lists their packages as direct npm dependencies. The
skill asks for a capability and an input kind. It does not contain a
package-name allowlist or provider selection table.

## Execution kinds

`module` providers export `read(request)` and may export `canHandle(request)`.
They return normalized data.

`instructions` providers bundle private agent instructions. An instruction
binding may also list package-relative `execution.resources`. The resolver
loads the entry instructions and only the knowledge files declared for that
binding. The core cannot execute these resources as ordinary JavaScript; the
agent follows them and submits normalized data through the same validator.

Every production binding declares a `knowledgeVersion`. Provider resolution
returns package version, binding ID, and knowledge version for audit. A surface
profile is never silently overwritten to reinterpret old observations.

## Provider knowledge

Provider repositories may keep versioned knowledge that materially improves
recognition or safe execution, including screen/state maps, exact export
fingerprints, field meanings, source-specific normalization, change-detection
features, supported environment variants, fallback routes, and stopping
conditions.

Knowledge must not contain production data, real account identifiers,
screenshots, cookies, tokens, credentials, signed URLs, or exported records.
Tests use only synthetic accounts and values. Raw evidence stays owner-only
outside Git and may be referenced by a private hash or evidence ID.

## Fail-closed rules

Resolution stops before any destination write when:

- no installed provider matches;
- more than one installed provider matches;
- the provider API major version is incompatible;
- a package manifest, binding, resource, or implementation is invalid;
- the requested run is unattended but the provider does not allow it; or
- normalized data fails validation or contains duplicate identity keys.

## Installation model

npm owns package installation, versions, integrity metadata, and the dependency
graph. The private `live-agency-provider-runtime` composition root installs the
public packages and private provider repositories as npm workspaces pinned by
Git submodules. Its absolute path is supplied to skill commands as
`--provider-root`. Skills request a capability and input kind; provider
repository names and binding IDs are not copied into skill routing tables.
