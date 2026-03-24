import { describe, expect, it, vi } from "vitest";

vi.mock("@agent/core", () => ({
  pathResolver: {
    resolve: vi.fn((logicalPath: string) => logicalPath),
  },
  ptyEngine: {
    list: vi.fn(() => ["pty-1"]),
    get: vi.fn(() => ({
      status: "running",
      lastUpdated: Date.UTC(2026, 2, 25, 0, 0, 0),
      adapter: { pid: 9012 },
    })),
  },
  safeExistsSync: vi.fn((target: string) =>
    target === "active/shared/runtime/computer/sessions" || target === "active/shared/runtime/browser/sessions",
  ),
  safeReaddir: vi.fn((target: string) => {
    if (target === "active/shared/runtime/computer/sessions") return ["system-1.json"];
    if (target === "active/shared/runtime/browser/sessions") return ["browser-1.json"];
    return [];
  }),
  safeReadFile: vi.fn((target: string) => {
    if (target.endsWith("system-1.json")) {
      return JSON.stringify({
        id: "system-1",
        executor: "system",
        status: "succeeded",
        latestAction: "type_into_focused_input",
        target: "Codex",
        detail: "focused input",
        updatedAt: "2026-03-25T00:00:02.000Z",
        actionCount: 3,
        metadata: {
          application: "Google Chrome",
          sessionCount: 1,
        },
      });
    }
    return JSON.stringify({
      session_id: "browser-1",
      lease_status: "ready",
      updated_at: "2026-03-25T00:00:01.000Z",
      pid: 1234,
      active_tab_id: "tab-1",
      tab_count: 2,
      action_trail_count: 4,
    });
  }),
}));

describe("Chronos computer sessions", () => {
  it("collects governed system sessions alongside browser and terminal sessions", async () => {
    const { collectComputerSessions } = await import("../presence/displays/chronos-mirror-v2/src/lib/computer-sessions");
    const sessions = collectComputerSessions();

    expect(sessions.find((session) => session.id === "system-1")).toMatchObject({
      kind: "system",
      status: "succeeded",
      target: "Codex",
      metadata: { application: "Google Chrome", sessionCount: 1 },
    });
    expect(sessions.find((session) => session.id === "browser-1")).toMatchObject({
      kind: "browser",
      pid: 1234,
    });
    expect(sessions.find((session) => session.id === "pty-1")).toMatchObject({
      kind: "terminal",
      pid: 9012,
    });
  });
});
