# Provider architecture

## Boundary

Public skills own validation, matching, dry runs, constrained writes,
post-write verification, and audit output. They accept normalized data and do
not know which provider package produced it.

Private providers own source recognition, source-specific parsing or
observation instructions, schema-change detection, and normalization.

Production data and secrets are neither public-skill resources nor provider
source files. They remain in approved runtime storage and secret managers.

## Capability contract

The first capabilities are:

- `creator-activity-source/v1`
- `creator-invitation-observation-source/v1`
- `creator-profile-observation-source/v1`

A provider declares one or more capabilities under `liveAgencyProvider` in its
`package.json`. It also declares compatible input kinds, execution kind, and
whether unattended execution is supported.

```json
{
  "peerDependencies": {
    "@live-agency-skills/source-provider-api": "^1.0.0"
  },
  "liveAgencyProvider": {
    "schemaVersion": 1,
    "provides": ["creator-activity-source/v1"],
    "inputKinds": ["text/markdown"],
    "unattended": false,
    "execution": {
      "kind": "module",
      "entry": "./src/index.js"
    }
  }
}
```

The consuming composition root lists the installed provider as a direct npm
dependency. The skill asks for a capability and an input kind. It does not
contain a package-name allowlist or provider selection table.

## Execution kinds

`module` providers export `read(request)` and may export `canHandle(request)`.
They return normalized data.

`instructions` providers bundle private agent instructions. The resolver may
load the resource, but the core cannot execute it as ordinary JavaScript. The
agent follows those instructions and submits normalized data through the same
validator.

## Fail-closed rules

Resolution stops before any destination write when:

- no installed provider matches;
- more than one installed provider matches;
- the provider API major version is incompatible;
- a manifest or implementation is invalid;
- the requested run is unattended but the provider does not allow it; or
- normalized data fails validation or contains duplicate identity keys.

## Installation model

npm owns package installation, versions, integrity metadata, and the dependency
graph. The remaining composition concern is only where the npm root lives. The
initial migration keeps that root local and explicit; provider IDs are not
copied into skills. A later installer may automate creation of the same npm root
without changing the contract.
