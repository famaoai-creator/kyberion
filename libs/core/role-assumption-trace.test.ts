import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATED_ROLE_ENV,
  resetRoleAssumptionPolicyCache,
  resolveRole,
  withExecutionContext,
} from './authority.js';
import { pathResolver } from './path-resolver.js';
import { getFoundationIo, registerFoundationIo } from './foundation/io.js';
import {
  callerFramesFromStack,
  resetRoleAssumptionTraceState,
  resolveRoleAssumptionTracePath,
  ROLE_ASSUMPTION_TRACE_ENV,
} from './role-assumption-trace.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
} from './secure-io.js';

const ENV_KEYS = [
  'SYSTEM_ROLE',
  'MISSION_ROLE',
  'KYBERION_PERSONA',
  ROLE_ASSUMPTION_TRACE_ENV,
  DELEGATED_ROLE_ENV,
];

function readTrace(file: string): Array<Record<string, unknown>> {
  return String(safeReadFile(file, { encoding: 'utf8' }))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('RN-01 role assumption trace', () => {
  const original: Record<string, string | undefined> = {};
  const relativeTrace = `active/shared/tmp/role-assumption-trace/test-${process.pid}/trace.jsonl`;
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

  it('records a delegated child role decision once, marked as a delegation (DR-01)', () => {
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = relativeTrace;
    process.env.SYSTEM_ROLE = 'concierge';
    process.env[DELEGATED_ROLE_ENV] = 'sovereign_concierge@concierge';
    expect(resolveRole()).toBe('sovereign_concierge');
    expect(resolveRole()).toBe('sovereign_concierge');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      process.env[DELEGATED_ROLE_ENV] = 'chronos_localadmin@concierge';
      expect(resolveRole()).toBe('concierge');
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes('ROLE_DELEGATION_DENIED'))
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(readTrace(traceFile)).toEqual([
      expect.objectContaining({
        system_role: 'concierge',
        assumed_role: 'sovereign_concierge',
        allowed: true,
        source: 'delegation',
      }),
      expect.objectContaining({
        system_role: 'concierge',
        assumed_role: 'chronos_localadmin',
        allowed: false,
        source: 'delegation',
      }),
    ]);
  });

  it('only accepts a .jsonl file in a dedicated trace directory (S5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveRoleAssumptionTracePath('knowledge/public/trace.jsonl')).toBeNull();
      expect(resolveRoleAssumptionTracePath('../outside/trace.jsonl')).toBeNull();
      // The shared tmp root itself is no longer enough: a dedicated directory is required.
      expect(resolveRoleAssumptionTracePath('active/shared/tmp/trace.jsonl')).toBeNull();
      expect(resolveRoleAssumptionTracePath('active/shared/runtime/x.jsonl')).toBeNull();
      expect(
        resolveRoleAssumptionTracePath('active/shared/runtime/role-assumption-trace/x.log')
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ROLE_ASSUMPTION_TRACE]'));
      expect(
        resolveRoleAssumptionTracePath('active/shared/runtime/role-assumption-trace/x.jsonl')
      ).toBe(
        path.join(pathResolver.rootDir(), 'active/shared/runtime/role-assumption-trace/x.jsonl')
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a trace path that goes through a symbolic link (S5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = path.dirname(traceFile);
    try {
      safeMkdir(path.join(dir, 'real'), { recursive: true });
      safeSymlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      const linked = path.relative(pathResolver.rootDir(), path.join(dir, 'link', 't.jsonl'));
      expect(resolveRoleAssumptionTracePath(linked)).toBeNull();
      safeSymlinkSync(path.join(dir, 'real', 'target.jsonl'), path.join(dir, 'leaf.jsonl'));
      const leaf = path.relative(pathResolver.rootDir(), path.join(dir, 'leaf.jsonl'));
      expect(resolveRoleAssumptionTracePath(leaf)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('never changes a decision when the trace write fails (S6)', () => {
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = relativeTrace;
    process.env.SYSTEM_ROLE = 'computer_surface';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = getFoundationIo();
    registerFoundationIo({
      ...original,
      exists: () => {
        throw new Error('io exploded');
      },
      appendFile: () => {
        throw new Error('io exploded');
      },
    });
    try {
      expect(withExecutionContext('infrastructure_sentinel', () => 'ran')).toBe('ran');
      expect(() => withExecutionContext('chronos_localadmin', () => undefined)).toThrow(
        /ROLE_ASSUMPTION_DENIED/
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled after a failure'));
    } finally {
      registerFoundationIo(original);
      warn.mockRestore();
    }
    expect(safeExistsSync(traceFile)).toBe(false);
  });

  it('never changes a decision when path resolution fails (S6)', () => {
    // Rejecting the path warns; a warn that throws must not escape either.
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = 'knowledge/public/trace.jsonl';
    process.env.SYSTEM_ROLE = 'computer_surface';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console exploded');
    });
    try {
      expect(withExecutionContext('infrastructure_sentinel', () => 'ran')).toBe('ran');
      expect(() => withExecutionContext('chronos_localadmin', () => undefined)).toThrow(
        /ROLE_ASSUMPTION_DENIED/
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('creates the trace file exclusively, then appends (S6)', () => {
    process.env[ROLE_ASSUMPTION_TRACE_ENV] = relativeTrace;
    const original = getFoundationIo();
    const calls: string[] = [];
    registerFoundationIo({
      ...original,
      createExclusiveFile: (file, content) => {
        calls.push('create');
        original.createExclusiveFile?.(file, content);
      },
      appendFile: (file, content) => {
        calls.push('append');
        original.appendFile(file, content);
      },
      writeFile: () => {
        throw new Error('the trace must not use the replacing writer');
      },
    });
    try {
      withExecutionContext('mission_controller', () => undefined);
      withExecutionContext('mission_controller', () => undefined);
    } finally {
      registerFoundationIo(original);
    }
    expect(calls).toEqual(['create', 'append', 'append']);
    expect(readTrace(traceFile)).toHaveLength(2);
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
      'libs/core/dist/mission-role.js:5:1 (withMissionRole)',
      'presence/displays/chronos-mirror-v2/.next/server/chunk.js:1:2',
    ]);
  });

  it('recognises the assumption path by function name inside a bundle', () => {
    const chunk = '/srv/kyberion/presence/displays/concierge/.next/server/chunks/12.js';
    const stack = [
      'Error',
      `    at captureStack (${chunk}:1:10)`,
      `    at traceRoleAssumption (${chunk}:1:20)`,
      `    at Object.withExecutionContext (${chunk}:1:30)`,
      `    at async GET (${chunk}:9:40)`,
    ].join('\n');
    expect(callerFramesFromStack(stack)).toEqual([
      'presence/displays/concierge/.next/server/chunks/12.js:9:40 (GET)',
    ]);
  });
});
