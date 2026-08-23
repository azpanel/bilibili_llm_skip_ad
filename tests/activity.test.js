import test from "node:test";
import assert from "node:assert/strict";
import { buildViewingActivity } from "../lib/statistics.js";

test("观看活跃度按日期和小时统计视频数", () => {
  const now = new Date(2026, 7, 24, 18).getTime();
  const activity = buildViewingActivity([
    { recognizedAt: new Date(2026, 7, 24, 9, 10).getTime() },
    { recognizedAt: new Date(2026, 7, 24, 9, 50).getTime() },
    { recognizedAt: new Date(2026, 7, 23, 12).getTime() },
    { recognizedAt: new Date(2026, 7, 16, 12).getTime() }
  ], 7, now);
  assert.equal(activity.dates.length, 7);
  assert.equal(activity.hours.length, 24);
  assert.equal(activity.hours[15].label, "15");
  assert.equal(activity.hours[9].cells.find((cell) => cell.key === "2026-08-24").count, 2);
  assert.equal(activity.hours[12].cells.find((cell) => cell.key === "2026-08-23").count, 1);
  assert.equal(activity.total, 3);
  assert.equal(activity.maxCount, 2);
  const longActivity = buildViewingActivity([], 45, now);
  assert.equal(longActivity.dates.length, 45);
  assert.equal(longActivity.dates.find((date) => date.key === "2026-08-01").label, "8-1");
  assert.equal(longActivity.dates.find((date) => date.key === "2026-08-02").label, "2");
});
