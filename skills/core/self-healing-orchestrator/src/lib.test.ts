import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { parseInput, matchRunbook } from './lib';

vi.mock('node:fs');

describe('self-healing-orchestrator lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should parse error patterns from plain text', () => {
    const mockContent = `INFO: starting
ERROR: Cannot find module lodash
FATAL: disk full`;
    vi.mocked(fs.readFileSync).mockReturnValue(mockContent);

    const errors = parseInput('dummy.log');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Cannot find module');
  });

  it('should match runbook rules correctly and sort by severity', () => {
    const errors = ['Error: MODULE_NOT_FOUND', 'Connection refused by peer'];
    const actions = matchRunbook(errors);

    expect(actions).toHaveLength(2);
    // econnrefused (high) should be before npm-missing-module (medium)
    expect(actions[0].ruleId).toBe('econnrefused');
    expect(actions[1].ruleId).toBe('npm-missing-module');
  });
});
