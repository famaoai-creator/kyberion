import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  agentPerformanceIndexPath,
  agentRoleOutcomesPath,
  loadAgentPerformanceIndexAtPath,
  parseAgentPerformanceIndex,
  rebuildAgentPerformanceIndex,
  recordAgentRoleOutcomes,
} from './agent-performance-index.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('agent performance index', () => {
  const outcomesPath = agentRoleOutcomesPath();
  const indexPath = agentPerformanceIndexPath();
  let originalOutcomes: string | null = null;
  let originalIndex: string | null = null;

  beforeAll(() => {
    if (safeExistsSync(outcomesPath)) {
      originalOutcomes = safeReadFile(outcomesPath, { encoding: 'utf8' }) as string;
    }
    if (safeExistsSync(indexPath)) {
      originalIndex = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    }
  });

  beforeEach(() => {
    vi.stubEnv('KYBERION_PERSONA', 'worker');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    safeRmSync(outcomesPath, { force: true });
    safeRmSync(indexPath, { force: true });
  });

  afterAll(() => {
    if (originalOutcomes !== null) safeWriteFile(outcomesPath, originalOutcomes);
    else safeRmSync(outcomesPath, { force: true });
    if (originalIndex !== null) safeWriteFile(indexPath, originalIndex);
    else safeRmSync(indexPath, { force: true });
    vi.unstubAllEnvs();
  });

  const valid = {
    by_agent_role: {
      'implementation-architect|implementer': {
        samples: 6,
        success: 5,
        review: 0,
        blocked: 1,
        success_rate: 0.8333,
      },
    },
  };

  it('parses the persisted projection into typed buckets', () => {
    expect(parseAgentPerformanceIndex(valid)).toEqual(valid);
  });

  it('rejects unknown fields and malformed role keys', () => {
    expect(() => parseAgentPerformanceIndex({ ...valid, generated_at: 'now' })).toThrow(
      'contains unknown field(s)'
    );
    expect(() =>
      parseAgentPerformanceIndex({
        by_agent_role: {
          implementer: valid.by_agent_role['implementation-architect|implementer'],
        },
      })
    ).toThrow('must be "agent|role"');
  });

  it('rejects dangerous keys and invalid performance values', () => {
    expect(() =>
      parseAgentPerformanceIndex(
        JSON.parse(
          '{"by_agent_role":{"__proto__":{"samples":1,"success":1,"review":0,"blocked":0,"success_rate":1}}}'
        )
      )
    ).toThrow('dangerous JSON key');
    expect(() =>
      parseAgentPerformanceIndex({
        by_agent_role: {
          'implementation-architect|implementer': {
            ...valid.by_agent_role['implementation-architect|implementer'],
            success_rate: 2,
          },
        },
      })
    ).toThrow('between 0 and 1');
  });

  it('rejects a directory before attempting to load the persisted index', () => {
    expect(() => loadAgentPerformanceIndexAtPath(pathResolver.knowledge('product'))).toThrow(
      'regular file'
    );
  });

  it('validates outcomes before append and skips schema-invalid persisted lines', () => {
    expect(() =>
      recordAgentRoleOutcomes([
        {
          mission_id: 'MSN-PERF-1',
          task_id: 'TSK-PERF-1',
          team_role: 'implementer',
          assignee: '',
          final_status: 'completed',
          recorded_at: '2026-09-03T00:00:00.000Z',
        },
      ])
    ).toThrow(/Invalid catalog agent-role-outcome/);
    expect(safeExistsSync(outcomesPath)).toBe(false);

    const validOutcome = {
      mission_id: 'MSN-PERF-1',
      task_id: 'TSK-PERF-1',
      team_role: 'implementer',
      assignee: 'agent-a',
      final_status: 'completed',
      recorded_at: '2026-09-03T00:00:00.000Z',
    };
    safeWriteFile(
      outcomesPath,
      `${JSON.stringify(validOutcome)}\n${JSON.stringify({ ...validOutcome, unexpected: true })}\n`
    );

    expect(rebuildAgentPerformanceIndex()).toEqual({
      'agent-a|implementer': {
        samples: 1,
        success: 1,
        review: 0,
        blocked: 0,
        success_rate: 1,
      },
    });
  });
});
