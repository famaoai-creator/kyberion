import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRoleAssumptionPolicyCache, withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import {
  callerFramesFromStack,
  resetRoleAssumptionTraceState,
  resolveRoleAssumptionTracePath,
  ROLE_ASSUMPTION_TRACE_ENV,
} from './role-assumption-trace.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

const ENV_KEYS = ['SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA', ROLE_ASSUMPTION_TRACE_ENV];

function readTrace(file: string): Array<Record<string, unknown>> {
  return String(safeReadFile(file, { encoding: 'utf8' }))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('RN-01 role assumption trace', () => {
  const original: Record<string, string | undefined> = {};
  const relativeTrace = `active/shared/tmp/role-assumption-trace-test-${process.pid}/trace.jsonl`;
  const traceFile = path.join(pathResolver.rootDir(), relativeTrace);

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
    resetRoleAssumptionTraceState();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetRoleAssumptionPolicyCache();
    resetRoleAssumptionTraceState();
    safeRmSync(path.dirname(traceFile), { recursive: true, force: true });
  });

  it('writes nothing when the trace is not configured', () => {
    withExecutionContext('mission_controller', () => undefined);
    expect(safeExistsSync(traceFile)).toBe(false);
  });

  it('records allowed and denied decisions with the calling module', () => {
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = relativeTrace;
    process.env.SYSTEM_ROLE = 'computer_surface';

    withExecutionContext('infrastructure_sentinel', () => undefined);
    expect(() => withExecutionContext('chronos_localadmin', () => undefined)).toThrow(
      /ROLE_ASSUMPTION_DENIED/
    );

    const records = readTrace(traceFile);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      system_role: 'computer_surface',
      assumed_role: 'infrastructure_sentinel',
      allowed: true,
    });
    expect(records[1]).toMatchObject({
      system_role: 'computer_surface',
      assumed_role: 'chronos_localadmin',
      allowed: false,
    });
    for (const record of records) {
      expect(String(record.caller)).toMatch(/^libs\/core\/role-assumption-trace\.test\.ts:\d+/);
      expect(Array.isArray(record.stack)).toBe(true);
      expect(typeof record.ts).toBe('string');
    }
  });

  it('records system_role null outside a SYSTEM_ROLE process', () => {
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = relativeTrace;
    withExecutionContext('mission_controller', () => undefined);
    expect(readTrace(traceFile)).toEqual([
      expect.objectContaining({
        system_role: null,
        assumed_role: 'mission_controller',
        allowed: true,
      }),
    ]);
  });

  it('ignores a trace path outside the runtime directories', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveRoleAssumptionTracePath('knowledge/public/trace.jsonl')).toBeNull();
      expect(resolveRoleAssumptionTracePath('../outside/trace.jsonl')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ROLE_ASSUMPTION_TRACE]'));
      expect(resolveRoleAssumptionTracePath('active/shared/runtime/x.jsonl')).toBe(
        path.join(pathResolver.rootDir(), 'active/shared/runtime/x.jsonl')
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('skips authority and node-internal frames and makes paths checkout-relative', () => {
    const stack = [
      'Error',
      '    at traceRoleAssumption (/repo/libs/core/dist/role-assumption-trace.js:10:5)',
      '    at assertRoleAssumptionAllowed (/repo/libs/core/dist/authority.js:20:3)',
      '    at withExecutionContext (file:///repo/libs/core/dist/authority.js:30:3)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at withMissionRole (/repo/libs/core/dist/mission-role.js:5:1)',
      '    at /repo/presence/displays/chronos-mirror-v2/.next/server/chunk.js:1:2',
    ].join('\n');
    expect(callerFramesFromStack(stack)).toEqual([
      'libs/core/dist/mission-role.js:5:1',
      'presence/displays/chronos-mirror-v2/.next/server/chunk.js:1:2',
    ]);
  });
});
