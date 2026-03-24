import { describe, expect, it } from "vitest";

import {
  extractMissionDependencies,
  findLatestMissionHandoff,
  normalizeMissionAssets,
  parseTaskBoard,
  summarizeNextTasks,
} from "../presence/displays/chronos-mirror-v2/src/lib/mission-progress";

describe("Chronos mission progress helpers", () => {
  it("parses task board step counts and status", () => {
    const snapshot = parseTaskBoard(`
# TASK_BOARD: TEST

## Status: Execution Ready

### Execution
- [x] Step 1: Research and Strategy
- [~] Step 2: Implementation
- [ ] Step 3: Validation

### Distillation
- [ ] Step 4: Knowledge Distillation
`);

    expect(snapshot).toEqual({
      boardStatus: "Execution Ready",
      boardStepsTotal: 4,
      boardStepsDone: 1,
      boardStepsActive: 1,
      boardStepsPending: 2,
    });
  });

  it("summarizes next task queue state", () => {
    const summary = summarizeNextTasks([
      { status: "planned" },
      { status: "completed" },
      { status: "accepted" },
      { status: "in_progress" },
    ]);

    expect(summary).toEqual({
      nextTasksTotal: 4,
      nextTasksPending: 2,
      nextTasksCompleted: 2,
    });
  });

  it("extracts dependency ids and normalizes asset paths", () => {
    expect(extractMissionDependencies({
      prerequisites: ["MSN-A", "MSN-B"],
      depends_on: ["MSN-B", "MSN-C"],
    })).toEqual(["MSN-A", "MSN-B", "MSN-C"]);

    expect(normalizeMissionAssets([
      {
        path: "evidence/result.json",
        category: "evidence",
        sizeBytes: 12,
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
      {
        path: "deliverables/slide.html",
        category: "deliverables",
        sizeBytes: 24,
        updatedAt: "2026-03-24T00:00:01.000Z",
      },
      {
        path: "deliverables/slide.html",
        category: "deliverables",
        sizeBytes: 24,
        updatedAt: "2026-03-24T00:00:01.000Z",
      },
      {
        path: "",
        category: "outputs",
        sizeBytes: 0,
        updatedAt: "2026-03-24T00:00:02.000Z",
      },
    ])).toEqual([
      {
        path: "deliverables/slide.html",
        category: "deliverables",
        sizeBytes: 24,
        updatedAt: "2026-03-24T00:00:01.000Z",
      },
      {
        path: "evidence/result.json",
        category: "evidence",
        sizeBytes: 12,
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    ]);
  });

  it("picks the latest handoff for a mission", () => {
    expect(findLatestMissionHandoff("MSN-ALPHA", [
      {
        ts: "2026-03-24T01:00:00.000Z",
        missionId: "MSN-ALPHA",
        sender: "planner",
        receiver: "worker-a",
        promptExcerpt: "draft the plan",
      },
      {
        ts: "2026-03-24T02:00:00.000Z",
        missionId: "MSN-BETA",
        sender: "planner",
        receiver: "worker-b",
      },
      {
        ts: "2026-03-24T03:00:00.000Z",
        missionId: "MSN-ALPHA",
        sender: "reviewer",
        receiver: "worker-c",
        promptExcerpt: "tighten the evidence",
      },
    ]))
      .toMatchObject({
        missionId: "MSN-ALPHA",
        sender: "reviewer",
        receiver: "worker-c",
        promptExcerpt: "tighten the evidence",
      });

    expect(findLatestMissionHandoff("MSN-GAMMA", [])).toBeNull();
  });
});
