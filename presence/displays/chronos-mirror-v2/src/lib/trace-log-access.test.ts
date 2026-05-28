import { describe, expect, it } from "vitest";

import { pathResolver } from "@agent/core/path-resolver";

import { isAllowedTraceLogPath, traceLogRoots } from "./trace-log-access";

describe("trace-log-access", () => {
  it("allows trace logs under the shared trace log root", () => {
    const sharedPath = pathResolver.shared("logs/traces/traces-2026-05-28.jsonl");
    expect(isAllowedTraceLogPath(sharedPath)).toBe(true);
  });

  it("rejects non-trace-log paths", () => {
    expect(isAllowedTraceLogPath(pathResolver.shared("logs/audit/audit.log"))).toBe(false);
  });

  it("exposes at least one trace log root", () => {
    expect(traceLogRoots().length).toBeGreaterThan(0);
  });
});
