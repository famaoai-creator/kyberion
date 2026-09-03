import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadAgentPerformanceIndexAtPath,
  parseAgentPerformanceIndex,
} from './agent-performance-index.js';

describe('agent performance index', () => {
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
});
