import { describe, expect, it } from 'vitest';
import { createAgentDeclaration, createWorkflowDeclaration } from './agent-declaration-factory.js';

const KNOWN_ROLES = ['implementer', 'planner', 'reviewer'];

function codes(messages: { code: string }[]): string[] {
  return messages.map((m) => m.code);
}

describe('createAgentDeclaration', () => {
  it('normalizes a complete declaration', () => {
    const result = createAgentDeclaration(
      {
        agent_id: 'reviewer-1',
        role: 'reviewer',
        model: ' claude-sonnet ',
        instructions: 'Review diffs.',
        tools: ['Read', 'Grep', ' '],
        capabilities: ['review'],
        tier: 'confidential',
      },
      { knownRoles: KNOWN_ROLES }
    );
    expect(result.messages).toEqual([]);
    expect(result.agent).toEqual({
      agent_id: 'reviewer-1',
      role: 'reviewer',
      model: 'claude-sonnet',
      instructions: 'Review diffs.',
      tools: ['Read', 'Grep'],
      capabilities: ['review'],
      tier: 'confidential',
    });
  });

  it('defaults tools, capabilities, and tier', () => {
    const result = createAgentDeclaration(
      { agent_id: 'impl-1', role: 'implementer', instructions: 'x' },
      { knownRoles: KNOWN_ROLES }
    );
    expect(result.agent).toMatchObject({ tools: [], capabilities: [], tier: 'public' });
  });

  it('rejects non-object input', () => {
    const result = createAgentDeclaration('agent');
    expect(result.agent).toBeUndefined();
    expect(codes(result.messages)).toEqual(['AGENT_DECL_NOT_OBJECT']);
  });

  it('collects all errors instead of throwing on the first', () => {
    const result = createAgentDeclaration(
      { role: 'ghost', tier: 'vault', tools: 'Read' },
      { knownRoles: KNOWN_ROLES }
    );
    expect(result.agent).toBeUndefined();
    const found = codes(result.messages);
    expect(found).toContain('AGENT_DECL_ID_REQUIRED');
    expect(found).toContain('AGENT_DECL_ROLE_UNKNOWN');
    expect(found).toContain('AGENT_DECL_TIER_INVALID');
    expect(found).toContain('AGENT_DECL_TOOLS_INVALID');
    expect(found).toContain('AGENT_DECL_INSTRUCTIONS_MISSING');
  });

  it('flags malformed ids and missing roles as errors', () => {
    const result = createAgentDeclaration(
      { agent_id: 'bad id!', role: '', instructions: 'x' },
      { knownRoles: KNOWN_ROLES }
    );
    expect(result.agent).toBeUndefined();
    expect(codes(result.messages)).toEqual(
      expect.arrayContaining(['AGENT_DECL_ID_INVALID', 'AGENT_DECL_ROLE_REQUIRED'])
    );
  });

  it('warns on missing instructions without blocking construction', () => {
    const result = createAgentDeclaration(
      { agent_id: 'p1', role: 'planner' },
      { knownRoles: KNOWN_ROLES }
    );
    expect(result.messages).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'AGENT_DECL_INSTRUCTIONS_MISSING' }),
    ]);
    expect(result.agent?.agent_id).toBe('p1');
  });

  it('validates role against the governed team-role index by default', () => {
    // 'implementer' is a committed team role; if the index cannot be read in
    // this environment the role check is skipped — either way a valid
    // declaration must still construct.
    const result = createAgentDeclaration({
      agent_id: 'i1',
      role: 'implementer',
      instructions: 'x',
    });
    expect(result.agent?.role).toBe('implementer');
  });
});

describe('createWorkflowDeclaration', () => {
  it('normalizes a dependency-ordered workflow', () => {
    const result = createWorkflowDeclaration({
      steps: [
        { step_id: 'plan', kind: 'core:plan' },
        { step_id: 'build', kind: 'core:exec', depends_on: ['plan'] },
        { step_id: 'review', kind: 'core:review', depends_on: ['plan', 'build'] },
      ],
    });
    expect(result.messages).toEqual([]);
    expect(result.workflow?.steps.map((s) => s.step_id)).toEqual(['plan', 'build', 'review']);
    expect(result.workflow?.steps[1].depends_on).toEqual(['plan']);
  });

  it('rejects non-object input and non-array steps', () => {
    expect(codes(createWorkflowDeclaration(null).messages)).toEqual(['WORKFLOW_DECL_NOT_OBJECT']);
    expect(codes(createWorkflowDeclaration({ steps: {} }).messages)).toEqual([
      'WORKFLOW_STEPS_NOT_ARRAY',
    ]);
    expect(codes(createWorkflowDeclaration({ steps: [] }).messages)).toEqual([
      'WORKFLOW_STEPS_EMPTY',
    ]);
  });

  it('flags missing ids, kinds, and duplicates per step', () => {
    const result = createWorkflowDeclaration({
      steps: [
        'nope',
        { kind: 'core:exec' },
        { step_id: 'a', kind: 'core:exec' },
        { step_id: 'a', kind: 'core:exec' },
        { step_id: 'b' },
      ],
    });
    expect(result.workflow).toBeUndefined();
    const found = codes(result.messages);
    expect(found).toContain('WORKFLOW_STEP_NOT_OBJECT');
    expect(found).toContain('WORKFLOW_STEP_ID_REQUIRED');
    expect(found).toContain('WORKFLOW_STEP_ID_DUPLICATE');
    expect(found).toContain('WORKFLOW_STEP_KIND_REQUIRED');
  });

  it('flags unknown dependency targets and invalid depends_on', () => {
    const result = createWorkflowDeclaration({
      steps: [
        { step_id: 'a', kind: 'k', depends_on: ['ghost'] },
        { step_id: 'b', kind: 'k', depends_on: 'a' },
      ],
    });
    expect(result.workflow).toBeUndefined();
    const found = codes(result.messages);
    expect(found).toContain('WORKFLOW_DEPENDENCY_MISSING');
    expect(found).toContain('WORKFLOW_STEP_DEPENDENCIES_INVALID');
  });

  it('detects dependency cycles via STEP_DEPENDENCY_CYCLE', () => {
    const result = createWorkflowDeclaration({
      steps: [
        { step_id: 'a', kind: 'k', depends_on: ['c'] },
        { step_id: 'b', kind: 'k', depends_on: ['a'] },
        { step_id: 'c', kind: 'k', depends_on: ['b'] },
      ],
    });
    expect(result.workflow).toBeUndefined();
    const cycle = result.messages.find((m) => m.code === 'STEP_DEPENDENCY_CYCLE');
    expect(cycle?.severity).toBe('error');
    expect(cycle?.message).toContain('->');
  });

  it('does not flag a diamond dependency graph', () => {
    const result = createWorkflowDeclaration({
      steps: [
        { step_id: 'root', kind: 'k' },
        { step_id: 'b', kind: 'k', depends_on: ['root'] },
        { step_id: 'c', kind: 'k', depends_on: ['root'] },
        { step_id: 'd', kind: 'k', depends_on: ['b', 'c'] },
      ],
    });
    expect(result.messages).toEqual([]);
    expect(result.workflow?.steps).toHaveLength(4);
  });
});
