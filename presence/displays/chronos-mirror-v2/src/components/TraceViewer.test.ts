import { describe, expect, it } from "vitest";

import {
  buildTraceFeedUrl,
  buildTraceFocusHistory,
  focusTraceRecord,
  loadTraceViewerPrefs,
  resolveTraceHotkeySelection,
  shouldOpenRawTracePanel,
} from "./TraceViewer";

describe("TraceViewer helpers", () => {
  it("builds a trace feed url with filters", () => {
    const url = buildTraceFeedUrl(
      12,
      {
        status: "error",
        missionId: "MSN-1",
        pipelineId: "pipe-2",
        actuator: "chronos",
        query: "alpha",
      },
      7,
    );

    expect(url).toContain("limit=12");
    expect(url).toContain("status=error");
    expect(url).toContain("missionId=MSN-1");
    expect(url).toContain("pipelineId=pipe-2");
    expect(url).toContain("actuator=chronos");
    expect(url).toContain("query=alpha");
    expect(url).toContain("_=7");
  });

  it("focuses the matching record from a raw jsonl trace log", () => {
    const focused = focusTraceRecord(
      [
        JSON.stringify({ traceId: "trace-a", value: 1 }),
        JSON.stringify({ traceId: "trace-b", value: 2 }),
      ].join("\n"),
      "trace-b",
    );

    expect(focused).toContain('"traceId": "trace-b"');
    expect(focused).not.toContain('"traceId": "trace-a"');
    expect(focused.endsWith("\n")).toBe(true);
  });

  it("returns the original raw text when the trace id is missing", () => {
    const raw = [
      JSON.stringify({ traceId: "trace-a", value: 1 }),
      JSON.stringify({ traceId: "trace-b", value: 2 }),
    ].join("\n");

    expect(focusTraceRecord(raw, "trace-z")).toBe(raw);
  });

  it("keeps a short most-recent-first trace focus history", () => {
    expect(buildTraceFocusHistory(["trace-a", "trace-b"], "trace-c", 3)).toEqual(["trace-c", "trace-a", "trace-b"]);
    expect(buildTraceFocusHistory(["trace-a", "trace-b"], "trace-a", 3)).toEqual(["trace-a", "trace-b"]);
  });

  it("loads trace viewer prefs with raw panel state", () => {
    const prefs = loadTraceViewerPrefs(
      JSON.stringify({
        filters: { missionId: "mission-1" },
        sort: "largest",
        selectedTraceId: "trace-1",
        rawTraceFocusTraceId: "trace-2",
        rawTraceFocusHistory: ["trace-2", "trace-3", "", "trace-2", 7],
        rawTraceVisible: true,
      }),
    );

    expect(prefs).toEqual({
      filters: {
        status: "all",
        missionId: "mission-1",
        pipelineId: "",
        actuator: "",
        query: "",
      },
      sort: "largest",
      selectedTraceId: "trace-1",
      rawTraceFocusTraceId: "trace-2",
      rawTraceFocusHistory: ["trace-2", "trace-3"],
      rawTraceVisible: true,
    });
  });

  it("auto-opens raw trace when the trace viewer is first focused", () => {
    expect(
      shouldOpenRawTracePanel({
        autoOpenRawTrace: true,
        rawTraceVisible: false,
        rawTraceLoadedTraceId: null,
        selectedTraceId: "trace-1",
        selectedTracePath: "/tmp/trace.jsonl",
        rawTraceLoading: false,
      }),
    ).toBe(true);
  });

  it("does not reopen a raw trace that is already loaded unless the trace changes", () => {
    expect(
      shouldOpenRawTracePanel({
        autoOpenRawTrace: true,
        rawTraceVisible: true,
        rawTraceLoadedTraceId: "trace-1",
        selectedTraceId: "trace-1",
        selectedTracePath: "/tmp/trace.jsonl",
        rawTraceLoading: false,
      }),
    ).toBe(false);

    expect(
      shouldOpenRawTracePanel({
        autoOpenRawTrace: true,
        rawTraceVisible: true,
        rawTraceLoadedTraceId: "trace-1",
        selectedTraceId: "trace-2",
        selectedTracePath: "/tmp/trace.jsonl",
        rawTraceLoading: false,
      }),
    ).toBe(true);
  });

  it("maps trace hotkeys to the visible trace order", () => {
    const traces = [
      { traceId: "trace-1" },
      { traceId: "trace-2" },
      { traceId: "trace-3" },
    ] as Array<{ traceId: string }>;

    expect(resolveTraceHotkeySelection(traces as any, null, "1")).toBe("trace-1");
    expect(resolveTraceHotkeySelection(traces as any, "trace-1", "2")).toBe("trace-2");
    expect(resolveTraceHotkeySelection(traces as any, "trace-1", "j")).toBe("trace-2");
    expect(resolveTraceHotkeySelection(traces as any, "trace-2", "k")).toBe("trace-1");
    expect(resolveTraceHotkeySelection(traces as any, null, "x")).toBeNull();
  });
});
