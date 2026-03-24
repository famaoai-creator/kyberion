import { describe, expect, it } from "vitest";

import {
  MISSION_CYCLE,
  OPERATOR_VIEW_LINKS,
  SURFACE_ROLES,
  buildAttentionItems,
} from "../presence/displays/chronos-mirror-v2/src/lib/operator-console";

describe("Chronos operator console helpers", () => {
  it("defines the expected surface taxonomy for human-agent connection", () => {
    expect(SURFACE_ROLES.map((entry) => entry.label)).toEqual([
      "Command Surface",
      "Control Surface",
      "Performance Surface",
      "Work Surface",
    ]);
  });

  it("defines the mission cycle through inspection and distillation", () => {
    expect(MISSION_CYCLE.map((entry) => entry.label)).toEqual([
      "Intent",
      "Mission",
      "Execution",
      "Explanation",
      "Inspection",
      "Distillation",
    ]);
  });

  it("exposes runtime topology in the operator view menu", () => {
    expect(OPERATOR_VIEW_LINKS.map((entry) => entry.label)).toContain("Runtime Topology");
    expect(OPERATOR_VIEW_LINKS.find((entry) => entry.label === "Runtime Topology")).toMatchObject({
      targetId: "runtime-topology-map",
    });
  });

  it("prioritizes mission and runtime exceptions in the attention queue", () => {
    const items = buildAttentionItems({
      missions: [
        {
          missionId: "MSN-ALPHA",
          nextTaskCount: 3,
          controlSummary: "planning pending",
          controlTone: "attention",
        },
        {
          missionId: "MSN-BETA",
          nextTaskCount: 1,
          controlSummary: "refresh pending",
          controlTone: "pending",
        },
      ],
      runtimeDoctor: [
        {
          severity: "critical",
          agentId: "chronos-mirror",
          ownerId: "chronos",
          reason: "Runtime lease without an active owner.",
          recommendedAction: "stop_runtime",
        },
      ],
      surfaces: [
        {
          id: "presence-studio",
          health: "unhealthy",
          controlSummary: "needs attention",
          controlTone: "attention",
        },
      ],
      outbox: [
        {
          message_id: "msg-1",
          surface: "chronos",
          text: "A delivery is waiting.",
        },
      ],
    });

    expect(items.map((item) => item.targetType)).toEqual([
      "mission",
      "mission",
      "runtime",
      "surface",
      "delivery",
    ]);
    expect(items[0]).toMatchObject({
      targetId: "MSN-ALPHA",
      tone: "critical",
    });
    expect(items[2]).toMatchObject({
      targetId: "chronos-mirror",
      remediationAction: "cleanup_runtime_lease",
    });
  });
});
