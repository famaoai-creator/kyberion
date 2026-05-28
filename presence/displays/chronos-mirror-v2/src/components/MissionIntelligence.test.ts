import { describe, expect, it } from "vitest";

import {
  pickDefaultMissionId,
  resolveMissionControlFocusId,
  resolveMissionThreadHotkeyAction,
} from "./MissionIntelligence";

describe("MissionIntelligence helpers", () => {
  it("prefers attention or pending missions when no mission is selected", () => {
    expect(
      pickDefaultMissionId(
        [
          { missionId: "MSN-1", controlTone: "ready", nextTaskCount: 1 },
          { missionId: "MSN-2", controlTone: "attention", nextTaskCount: 2 },
          { missionId: "MSN-3", controlTone: "pending", nextTaskCount: 3 },
        ] as Array<{
          missionId: string;
          controlTone: "planning" | "ready" | "attention" | "pending";
          nextTaskCount: number;
        }>,
        null,
      ),
    ).toBe("MSN-2");
  });

  it("prefers the most active mission when nothing is attention-worthy", () => {
    expect(
      pickDefaultMissionId(
        [
          { missionId: "MSN-1", controlTone: "ready", nextTaskCount: 1 },
          { missionId: "MSN-2", controlTone: "ready", nextTaskCount: 12 },
          { missionId: "MSN-3", controlTone: "planning", nextTaskCount: 40 },
        ] as Array<{
          missionId: string;
          controlTone: "planning" | "ready" | "attention" | "pending";
          nextTaskCount: number;
        }>,
        null,
      ),
    ).toBe("MSN-2");
  });

  it("respects an already selected mission", () => {
    expect(
      pickDefaultMissionId(
        [
          { missionId: "MSN-1", controlTone: "attention", nextTaskCount: 1 },
          { missionId: "MSN-2", controlTone: "planning", nextTaskCount: 2 },
        ] as Array<{
          missionId: string;
          controlTone: "planning" | "ready" | "attention" | "pending";
          nextTaskCount: number;
        }>,
        "MSN-2",
      ),
    ).toBe("MSN-2");
  });

  it("falls back when the selected mission no longer exists", () => {
    expect(
      pickDefaultMissionId(
        [
          { missionId: "MSN-1", controlTone: "ready", nextTaskCount: 1 },
          { missionId: "MSN-2", controlTone: "attention", nextTaskCount: 2 },
        ] as Array<{
          missionId: string;
          controlTone: "planning" | "ready" | "attention" | "pending";
          nextTaskCount: number;
        }>,
        "MSN-9",
      ),
    ).toBe("MSN-2");
  });

  it("prefers an externally focused mission when one is provided", () => {
    expect(
      resolveMissionControlFocusId(
        [
          { missionId: "MSN-1", controlTone: "ready", nextTaskCount: 1 },
          { missionId: "MSN-2", controlTone: "attention", nextTaskCount: 2 },
          { missionId: "MSN-3", controlTone: "pending", nextTaskCount: 3 },
        ] as Array<{
          missionId: string;
          controlTone: "planning" | "ready" | "attention" | "pending";
          nextTaskCount: number;
        }>,
        "MSN-1",
        "MSN-3",
      ),
    ).toBe("MSN-3");
  });

  it("maps mission thread hotkeys to the expected actions", () => {
    expect(resolveMissionThreadHotkeyAction("t")).toBe("thread");
    expect(resolveMissionThreadHotkeyAction("T")).toBe("thread");
    expect(resolveMissionThreadHotkeyAction("c")).toBe("card");
    expect(resolveMissionThreadHotkeyAction("x")).toBeNull();
  });
});
