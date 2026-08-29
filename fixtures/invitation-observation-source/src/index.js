export default {
  canHandle(request) {
    return (
      request.inputKind === "application/x.synthetic-observation-request+json" &&
      Array.isArray(request.targets)
    );
  },
  read(request) {
    return {
      observedAt: request.observedAt,
      rowCount: request.targets.length,
      creators: request.targets.map((target) => ({
        accountKey: target.accountKey,
        state: "synthetic_pending",
        externalUserId: `fixture-${target.accountKey}`,
        nickname: `Fixture ${target.accountKey}`,
      })),
    };
  },
};
