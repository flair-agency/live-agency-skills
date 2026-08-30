import assert from "node:assert/strict";
import test from "node:test";

import { isRecordId as isInsightRecordId } from "../skills/creator-insight-sync/scripts/insight_sync_core.mjs";
import { isRecordId as isLiveRecordId } from "../skills/creator-live-history-sync/scripts/live_history_sync_core.mjs";
import { isRecordId as isMetricCompactionRecordId } from "../skills/creator-live-metrics-compaction/scripts/lark_live_metrics_compact.mjs";
import { isRecordId as isProfileCompactionRecordId } from "../skills/creator-profile-compaction/scripts/lark_profile_compact.mjs";
import { isRecordId as isProfileRecordId } from "../skills/creator-profile-sync/scripts/profile_sync_core.mjs";

test("current and legacy Lark record IDs are accepted consistently", () => {
  const validators = [
    isInsightRecordId,
    isLiveRecordId,
    isMetricCompactionRecordId,
    isProfileCompactionRecordId,
    isProfileRecordId,
  ];
  for (const validator of validators) {
    assert.equal(validator("recYyFHagy"), true);
    assert.equal(validator("recv3LTUOVCCpf"), true);
    assert.equal(validator("rec-short"), false);
    assert.equal(validator("tblYyFHagy"), false);
  }
});
