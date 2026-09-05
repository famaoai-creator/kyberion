/** PI-02: reject raw exception interpolation in network-facing error replies. */
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const root = process.cwd();
export const WIRE_ERROR_BOUNDARY_FILES = [
  'libs/shared-network/src/mcp-server-engine.ts',
  'libs/core/peer-messaging.ts',
  'presence/displays/chronos-mirror-v2/src/lib/viewer-context.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/agents/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/connections/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/deliverable-preview/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/deliverable-review/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/intelligence/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/intelligence/stream/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/knowledge-ref/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/knowledge-feedback/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/mission-asset/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/organization-operating-model/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/os/share-grants/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/plan-preview/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/runtime-file/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/tenant-scope/route.ts',
  'presence/displays/chronos-mirror-v2/src/app/api/workitems/route.ts',
  'presence/displays/presence-studio/server.ts',
  'presence/displays/presence-studio/presence-studio-runtime-data.ts',
  'scripts/browser_bridge_host.ts',
  'presence/displays/computer-surface/server.ts',
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
    const rawObjectPattern =
      /\berror:\s*(?:err|error)(?:\.|\?\.)message\b|\berror:\s*(?:err|error)\s+instanceof\s+Error\s*\?\s*(?:err|error)(?:\.|\?\.)message\b/gu;
    for (const match of source.matchAll(rawObjectPattern)) {
      findings.push(`${file}: raw exception message in JSON error near offset ${match.index}`);
    }
  }
  if (file.includes('/app/api/') && /\bdebug(?:Error|Stack)\s*:/u.test(source)) {
    findings.push(`${file}: raw debug error fields are exposed on the wire`);
  }
  if (file.includes('/presence-studio/') || file.includes('/computer-surface/')) {
    const rawJsonPattern =
      /\.json\(\s*\{[^}]{0,400}?\berror:\s*(?:err|error)(?:\.|\?\.)message\b|\.json\(\s*\{[^}]{0,400}?\berror:\s*(?:err|error)\s+instanceof\s+Error\s*\?\s*(?:err|error)(?:\.|\?\.)message\b|\.json\(\s*\{[^}]{0,400}?\berror:\s*`[^`]*\$\{(?:err|error)/gu;
    for (const match of source.matchAll(rawJsonPattern)) {
      findings.push(`${file}: raw exception message in JSON error near offset ${match.index}`);
    }
  }
  if (
    file === 'scripts/browser_bridge_host.ts' ||
    file.endsWith('/scripts/browser_bridge_host.ts')
  ) {
    const rawBridgePattern =
      /\berror:\s*(?:`[^`]*\$\{(?:err|error)[^}]*\}|(?:err|error)\s+instanceof\s+Error\s*\?\s*(?:err|error)(?:\.|\?\.)message|(?:err|error)(?:\.|\?\.)message)/gu;
    for (const match of source.matchAll(rawBridgePattern)) {
      findings.push(
        `${file}: raw exception message in browser bridge response near offset ${match.index}`
      );
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
      throw new ScriptExitError(
        1,
        ['FAILED', ...findings.map((finding) => `- ${finding}`)].join('\n')
      );
    }
    context.print('[check_wire_error_boundary] OK');
    return { findings };
  },
});

if (
  isDirectScript(import.meta.url, 'check_wire_error_boundary.ts') ||
  isDirectScript(import.meta.url, 'check_wire_error_boundary.js')
)
  void runCheckWireErrorBoundary();
