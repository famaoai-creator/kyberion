/** PI-02: reject raw exception interpolation in network-facing error replies. */
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

const root = process.cwd();
export const WIRE_ERROR_BOUNDARY_FILES = [
  'libs/shared-network/src/mcp-server-engine.ts',
  'libs/core/peer-messaging.ts',
  'presence/displays/chronos-mirror-v2/src/lib/viewer-context.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/agents/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/connections/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/deliverable-preview/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/deliverable-review/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/intelligence/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/intelligence/stream/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/knowledge-ref/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/mission-asset/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/organization-operating-model/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/os/share-grants/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/plan-preview/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/tenant-scope/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/workitems/route.ts',
];
const DEFAULT_WIRE_ERROR_FILE = WIRE_ERROR_BOUNDARY_FILES[0];

/** Exported for hermetic fixture tests and future route-specific extensions. */
export function findWireErrorBoundaryViolations(
  source: string,
  file = DEFAULT_WIRE_ERROR_FILE
): string[] {
  const findings: string[] = [];
  const rawReplyPattern = /text:\s*`[^`]*\$\{(?:err|error|message)\}/gu;
  for (const match of source.matchAll(rawReplyPattern)) {
    findings.push(`${file}: raw exception interpolation in wire text near offset ${match.index}`);
  }
  if (file.includes('/app/api/')) {
    const rawObjectPattern = /\berror:\s*(?:err|error)(?:\?\.)?\.message\b/gu;
    for (const match of source.matchAll(rawObjectPattern)) {
      findings.push(`${file}: raw exception message in JSON error near offset ${match.index}`);
    }
  }
  return findings;
}

export function scanWireErrorBoundary(): string[] {
  return WIRE_ERROR_BOUNDARY_FILES.flatMap((file) => {
    const source = String(safeReadFile(path.join(root, file), { encoding: 'utf8' }) || '');
    return findWireErrorBoundaryViolations(source, file);
  });
}

export const runCheckWireErrorBoundary = defineScript({
  name: 'check:wire-error-boundary',
  flags: [],
  run(context) {
    const findings = scanWireErrorBoundary();
    if (findings.length > 0) {
      console.error('[check_wire_error_boundary] FAILED');
      for (const finding of findings) console.error(`- ${finding}`);
      process.exitCode = 1;
      return;
    }
    context.print('[check_wire_error_boundary] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_wire_error_boundary.ts') ||
  isDirectScript(import.meta.url, 'check_wire_error_boundary.js')
)
  void runCheckWireErrorBoundary();
