export default {
  read(request) {
    return {
      month: request.month,
      sourceUpdatedAt: request.sourceUpdatedAt,
      rowCount: 1,
      creators: [{
        accountKey: "synthetic_multi",
        diamonds: 1,
        effectiveLiveDays: 1,
        liveMinutes: 1,
      }],
    };
  },
};
