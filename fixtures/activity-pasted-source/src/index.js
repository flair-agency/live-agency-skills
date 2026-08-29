export default {
  canHandle(request) {
    return request.inputKind === "text/markdown" && typeof request.text === "string";
  },
  read(request) {
    return {
      month: request.month,
      sourceUpdatedAt: request.sourceUpdatedAt,
      rowCount: 1,
      creators: [
        {
          accountKey: "synthetic_creator",
          diamonds: 100,
          effectiveLiveDays: 2,
          liveMinutes: 90,
        },
      ],
    };
  },
};
