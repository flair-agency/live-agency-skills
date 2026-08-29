import { createHash } from "node:crypto";

export default {
  async read(request) {
    const accountKey = request.accountKey ?? "synthetic.sender";
    const snapshotDate = request.snapshotDate ?? "2030-01-02";
    const occurredAt = request.occurredAt ?? "2030-01-01T12:00:00.000Z";
    const amount = String(request.amount ?? 100);
    const recipientKey = request.recipientKey ?? "synthetic.recipient";
    const sourceSha256 = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    return {
      version: 1,
      snapshotDate,
      observedAt: "2030-01-02T03:04:05.000Z",
      accountKey,
      sourceSha256,
      rowCount: 1,
      events: [{
        eventKey: "synthetic-event-0001",
        accountKey,
        occurredAt,
        amount,
        recipientKey,
      }],
    };
  },
};
