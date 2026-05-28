import path from "node:path";

import { customerRoot } from "@agent/core/customer-resolver";
import { pathResolver } from "@agent/core/path-resolver";

export function traceLogRoots(): string[] {
  const roots: string[] = [pathResolver.shared("logs/traces")];
  const customerTraceRoot = customerRoot("logs/traces");
  if (customerTraceRoot) roots.unshift(customerTraceRoot);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function isAllowedTraceLogPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || "").trim();
  if (!normalized) return false;
  if (!/\.jsonl$/i.test(normalized)) return false;

  const resolved = path.resolve(normalized);
  return traceLogRoots().some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}
