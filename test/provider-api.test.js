import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTIVITY_CAPABILITY,
  INVITATION_CAPABILITY,
  ProviderResolutionError,
  discoverProviders,
  readFromProvider,
  resolveProvider,
  validateActivitySnapshot,
  validateInvitationObservations,
  validateProviderPackage,
} from "@live-agency-skills/source-provider-api";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("discovers and executes a source-neutral fixture provider", async () => {
  const providers = await discoverProviders({ rootDir });
  const request = {
    inputKind: "text/markdown",
    month: "2030-01",
    sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
    text: "synthetic input",
  };
  const provider = await resolveProvider({ providers, capability: ACTIVITY_CAPABILITY, request });
  const snapshot = validateActivitySnapshot(await readFromProvider(provider, request));
  assert.equal(snapshot.creators[0].liveMinutes, 90);
});

test("an interactive provider cannot satisfy an unattended run", async () => {
  const providers = await discoverProviders({ rootDir });
  await assert.rejects(
    resolveProvider({
      providers,
      capability: ACTIVITY_CAPABILITY,
      request: { inputKind: "text/markdown", text: "synthetic input" },
      unattended: true,
    }),
    (error) => error instanceof ProviderResolutionError && error.code === "PROVIDER_NOT_FOUND",
  );
});

test("loads an instruction provider through its capability", async () => {
  const providers = await discoverProviders({ rootDir });
  const provider = await resolveProvider({
    providers,
    capability: INVITATION_CAPABILITY,
    request: { inputKind: "agent/instructions" },
  });
  assert.equal(provider.executionKind, "instructions");
  assert.match(provider.instructions, /Synthetic observation instructions/);

  const observations = validateInvitationObservations({
    observedAt: "2030-01-02T03:04:05.000Z",
    rowCount: 1,
    creators: [{ accountKey: "synthetic_creator", state: "synthetic_pending" }],
  });
  assert.equal(observations.rowCount, 1);
});

test("invitation observations require a real timezone-aware ISO date-time", () => {
  const snapshot = (observedAt) => ({
    observedAt,
    rowCount: 1,
    creators: [{ accountKey: "synthetic_creator", state: "synthetic_pending" }],
  });
  assert.doesNotThrow(() =>
    validateInvitationObservations(snapshot("2030-01-02T12:04:05.123+09:00")),
  );
  for (const value of [
    "2030-01-02",
    "2030-01-02T03:04:05",
    "2030-02-30T03:04:05.000Z",
    "2030-01-02T03:04:05.000+14:01",
  ]) {
    assert.throws(() => validateInvitationObservations(snapshot(value)), /ISO date-time/);
  }
});

test("selects one binding from a multi-capability provider and loads its knowledge", async () => {
  const providers = await discoverProviders({
    rootDir,
    dependencyNames: ["@fixture/multi-binding-provider"],
  });
  assert.equal(providers.length, 2);

  const activity = await resolveProvider({
    providers,
    capability: ACTIVITY_CAPABILITY,
    request: {
      inputKind: "application/x.synthetic-multi-activity+json",
      month: "2030-01",
      sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
    },
    unattended: true,
  });
  assert.equal(activity.bindingId, "synthetic-activity");
  assert.equal(activity.knowledgeVersion, "synthetic-activity/1");

  const invitation = await resolveProvider({
    providers,
    capability: INVITATION_CAPABILITY,
    request: { inputKind: "application/x.synthetic-multi-invitation+json" },
  });
  assert.equal(invitation.bindingId, "synthetic-invitation");
  assert.equal(invitation.knowledgeVersion, "synthetic-invitation/1");
  assert.match(invitation.instructions, /Synthetic bundled knowledge/);
});

test("missing and ambiguous providers fail closed", async () => {
  const providers = await discoverProviders({
    rootDir,
    dependencyNames: ["@fixture/activity-pasted-source"],
  });
  await assert.rejects(
    resolveProvider({
      providers: [],
      capability: ACTIVITY_CAPABILITY,
      request: { inputKind: "text/markdown" },
    }),
    (error) => error instanceof ProviderResolutionError && error.code === "PROVIDER_NOT_FOUND",
  );
  await assert.rejects(
    resolveProvider({
      providers: [providers[0], { ...providers[0], packageName: "@fixture/duplicate" }],
      capability: ACTIVITY_CAPABILITY,
      request: { inputKind: "text/markdown", text: "synthetic input" },
    }),
    (error) => error instanceof ProviderResolutionError && error.code === "PROVIDER_AMBIGUOUS",
  );
});

test("rejects an incompatible provider API before execution", () => {
  assert.throws(
    () =>
      validateProviderPackage(
        "@fixture/incompatible",
        {
          name: "@fixture/incompatible",
          version: "1.0.0",
          peerDependencies: { "@live-agency-skills/source-provider-api": "^2.0.0" },
          liveAgencyProvider: {
            schemaVersion: 1,
            provides: [ACTIVITY_CAPABILITY],
            inputKinds: ["text/markdown"],
            unattended: false,
            execution: { kind: "module", entry: "./src/index.js" },
          },
        },
        path.join(rootDir, "fixtures", "activity-pasted-source"),
      ),
    (error) => error instanceof ProviderResolutionError && error.code === "INCOMPATIBLE_API",
  );
});

test("duplicate normalized identities fail validation", () => {
  assert.throws(
    () =>
      validateActivitySnapshot({
        month: "2030-01",
        sourceUpdatedAt: "2030-01-02T03:04:05.000Z",
        rowCount: 2,
        creators: [
          { accountKey: "same", diamonds: 1, effectiveLiveDays: 1, liveMinutes: 1 },
          { accountKey: "same", diamonds: 2, effectiveLiveDays: 2, liveMinutes: 2 },
        ],
      }),
    /duplicated/,
  );
});
