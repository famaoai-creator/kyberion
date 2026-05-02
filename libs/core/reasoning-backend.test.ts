import { afterEach, describe, expect, it } from 'vitest';
import {
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';

describe('reasoning-backend', () => {
  afterEach(() => {
    resetReasoningBackend();
  });

  it('defaults to the stub backend when none is registered', () => {
    expect(getReasoningBackend().name).toBe('stub');
  });

  it('resolves a registered backend', () => {
    const fake: ReasoningBackend = {
      name: 'fake',
      divergePersonas: stubReasoningBackend.divergePersonas,
      crossCritique: stubReasoningBackend.crossCritique,
      synthesizePersona: stubReasoningBackend.synthesizePersona,
      forkBranches: stubReasoningBackend.forkBranches,
      simulateBranches: stubReasoningBackend.simulateBranches,
      extractRequirements: stubReasoningBackend.extractRequirements,
      extractDesignSpec: stubReasoningBackend.extractDesignSpec,
      extractTestPlan: stubReasoningBackend.extractTestPlan,
      decomposeIntoTasks: stubReasoningBackend.decomposeIntoTasks,
      delegateTask: stubReasoningBackend.delegateTask,
      prompt: stubReasoningBackend.prompt,
    };
    registerReasoningBackend(fake);
    expect(getReasoningBackend().name).toBe('fake');
  });

  describe('stub backend', () => {
    it('diverges personas into hypotheses', async () => {
      const result = await stubReasoningBackend.divergePersonas({
        topic: 'pricing strategy',
        personas: ['Visionary', 'Auditor'],
        minPerPersona: 2,
      });
      expect(result).toHaveLength(4);
      expect(result.every((h) => h.proposed_by && h.content.includes('[STUB]'))).toBe(true);
    });

    it('cross-critiques with deterministic survival pattern', async () => {
      const hypotheses = await stubReasoningBackend.divergePersonas({
        topic: 'x',
        personas: ['A', 'B'],
        minPerPersona: 1,
      });
      const critique = await stubReasoningBackend.crossCritique({
        topic: 'x',
        hypotheses,
        personas: ['A', 'B'],
      });
      expect(critique.hypotheses).toHaveLength(2);
      expect(critique.hypotheses.filter((h) => h.survived)).toHaveLength(1);
    });

    it('synthesizes a persona from a relationship node', async () => {
      const persona = await stubReasoningBackend.synthesizePersona({
        relationshipNode: {
          identity: { name: 'A' },
          communication_style: { tempo: 'fast' },
          ng_topics: ['x'],
          history: [1, 2, 3, 4],
        },
      });
      expect(persona.identity).toEqual({ name: 'A' });
      expect(persona.ng_topics).toEqual(['x']);
      expect(persona.recent_history_summary).toHaveLength(3);
    });

    it('forks only surviving hypotheses', async () => {
      const branches = await stubReasoningBackend.forkBranches({
        hypotheses: [
          { id: 'H1', proposed_by: 'A', content: 'c', status: 'survived' },
          { id: 'H2', proposed_by: 'A', content: 'c', status: 'rejected' },
        ],
        executionProfile: 'counterfactual',
        costCapTokens: 1000,
        maxStepsPerBranch: 5,
      });
      expect(branches).toHaveLength(1);
      expect(branches[0].hypothesis_ref).toBe('H1');
    });

    it('simulates each branch with null terminals', async () => {
      const result = await stubReasoningBackend.simulateBranches({
        branches: [
          { branch_id: 'A', hypothesis_ref: 'H1', worktree_path: 'x/' },
        ],
        goal: 'ship',
      });
      expect(result.branches[0].terminated_at_step).toBeNull();
    });
  });
});
