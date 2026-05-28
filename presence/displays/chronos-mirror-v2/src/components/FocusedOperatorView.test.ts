import { describe, expect, it } from "vitest";

import {
  attentionItemTargetMissionId,
  attentionItemTargetViewId,
  pickDefaultSessionId,
  resolveComputerSessionHotkeySelection,
} from "./FocusedOperatorView";

describe("FocusedOperatorView helpers", () => {
  it("maps attention items to the related focused view", () => {
    expect(attentionItemTargetViewId({ id: "mission-1", title: "Mission", reason: "", tone: "warning", targetType: "mission", targetId: "MSN-1" })).toBe("mission-control-plane");
    expect(attentionItemTargetMissionId({ id: "mission-1", title: "Mission", reason: "", tone: "warning", targetType: "mission", targetId: "MSN-1" })).toBe("MSN-1");
    expect(attentionItemTargetViewId({ id: "runtime-1", title: "Runtime", reason: "", tone: "warning", targetType: "runtime", targetId: "rt-1" })).toBe("runtime-lease-doctor");
    expect(attentionItemTargetMissionId({ id: "runtime-1", title: "Runtime", reason: "", tone: "warning", targetType: "runtime", targetId: "rt-1" })).toBeNull();
    expect(attentionItemTargetViewId({ id: "surface-1", title: "Surface", reason: "", tone: "warning", targetType: "surface", targetId: "surface-1" })).toBe("runtime-topology-map");
    expect(attentionItemTargetViewId({ id: "delivery-1", title: "Delivery", reason: "", tone: "warning", targetType: "delivery", targetId: "msg-1" })).toBe("recent-surface-outbox");
    expect(attentionItemTargetViewId({ id: "approval-1", title: "Approval", reason: "", tone: "warning", targetType: "approval", targetId: "appr-1" })).toBe("secret-approval-queue");
  });

  it("prefers an active browser session when no session is selected", () => {
    expect(
      pickDefaultSessionId(
        [
          { id: "terminal-1", kind: "terminal", status: "active", updatedAt: "2026-05-28T10:00:00Z" },
          { id: "browser-1", kind: "browser", status: "active", updatedAt: "2026-05-28T10:01:00Z" },
          { id: "system-1", kind: "system", status: "inactive", updatedAt: "2026-05-28T10:02:00Z" },
        ],
        null,
      ),
    ).toBe("browser-1");
  });

  it("falls back to the most recent session when nothing is active", () => {
    expect(
      pickDefaultSessionId(
        [
          { id: "terminal-1", kind: "terminal", status: "idle", updatedAt: "2026-05-28T10:00:00Z" },
          { id: "browser-1", kind: "browser", status: "idle", updatedAt: "2026-05-28T10:01:00Z" },
        ],
        null,
      ),
    ).toBe("browser-1");

    expect(
      pickDefaultSessionId(
        [
          { id: "browser-1", kind: "browser", status: "idle", updatedAt: "2026-05-28T10:01:00Z" },
          { id: "system-1", kind: "system", status: "paused", updatedAt: "2026-05-28T10:02:00Z" },
        ],
        null,
      ),
    ).toBe("system-1");
  });

  it("respects an already selected session", () => {
    expect(
      pickDefaultSessionId(
        [
          { id: "browser-1", kind: "browser", status: "active", updatedAt: "2026-05-28T10:01:00Z" },
          { id: "terminal-1", kind: "terminal", status: "active", updatedAt: "2026-05-28T10:00:00Z" },
        ],
        "terminal-1",
      ),
    ).toBe("terminal-1");
  });

  it("falls back when the selected session no longer exists", () => {
    expect(
      pickDefaultSessionId(
        [
          { id: "browser-1", kind: "browser", status: "idle", updatedAt: "2026-05-28T10:01:00Z" },
          { id: "system-1", kind: "system", status: "paused", updatedAt: "2026-05-28T10:02:00Z" },
        ],
        "missing-session",
      ),
    ).toBe("system-1");
  });

  it("maps computer session hotkeys to the listed sessions", () => {
    const sessions = [
      { id: "browser-1", kind: "browser", status: "active", updatedAt: "2026-05-28T10:01:00Z" },
      { id: "terminal-1", kind: "terminal", status: "active", updatedAt: "2026-05-28T10:00:00Z" },
      { id: "system-1", kind: "system", status: "paused", updatedAt: "2026-05-28T10:02:00Z" },
    ];

    expect(resolveComputerSessionHotkeySelection(sessions, null, "1")).toBe("browser-1");
    expect(resolveComputerSessionHotkeySelection(sessions, "browser-1", "2")).toBe("terminal-1");
    expect(resolveComputerSessionHotkeySelection(sessions, "terminal-1", "j")).toBe("system-1");
    expect(resolveComputerSessionHotkeySelection(sessions, "terminal-1", "k")).toBe("browser-1");
    expect(resolveComputerSessionHotkeySelection(sessions, null, "x")).toBeNull();
  });
});
