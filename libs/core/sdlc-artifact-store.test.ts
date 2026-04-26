import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return { ...actual, missionEvidenceDir: vi.fn() };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'public',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { missionEvidenceDir } from './path-resolver.js';
import {
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  evaluateTaskPlanReadyGate,
  readDesignSpec,
  readTaskPlan,
  readTestPlan,
  saveDesignSpec,
  saveTaskPlan,
  saveTestPlan,
} from './sdlc-artifact-store.js';

const designExtracted = {
  components: [
    {
      id: 'COMP-1',
      name: 'Core Service',
      responsibility: 'Handles business logic',
      requirements_refs: ['FR-1'],
    },
  ],
  data_flows: [],
  trade_offs: [],
  risks: [],
  open_decisions: [],
};
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

const testExtracted = {
  app_id: 'sample-app',
  cases: [
    {
      case_id: 'TC-1',
      title: 'Happy path',
      objective: 'Verify FR-1',
      steps: ['do x'],
      expected: 'outcome y',
      covers_requirements: ['FR-1'],
    },
  ],
};

const decomposed = {
  tasks: [
    {
      task_id: 'T-IMPL-1',
      title: 'Implement core',
      summary: 'core module',
      priority: 'must' as const,
      estimate: 'M' as const,
      test_criteria: ['core tests pass'],
    },
    {
      task_id: 'T-REVIEW-1',
      title: 'Review',
      summary: 'PR review',
      priority: 'should' as const,
      estimate: 'S' as const,
      depends_on: ['T-IMPL-1'],
    },
  ],
};

describe('sdlc-artifact-store', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-'));
    (missionEvidenceDir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('design spec', () => {
    it('saves and reads back a design spec with bumped version', () => {
      const saved = saveDesignSpec({
        missionId: 'MSN-D',
        projectName: 'X',
        extracted: designExtracted,
        generatedBy: 'stub',
      });
      expect(saved.version).toBe('v1');
      const read = readDesignSpec('MSN-D');
      expect(read?.components[0].id).toBe('COMP-1');
      const second = saveDesignSpec({
        missionId: 'MSN-D',
        projectName: 'X',
        extracted: designExtracted,
      });
      expect(second.version).toBe('v2');
    });

    it('ARCHITECTURE_READY passes on clean spec', () => {
      saveDesignSpec({ missionId: 'MSN-D1', projectName: 'X', extracted: designExtracted });
      expect(evaluateArchitectureReadyGate('MSN-D1').passed).toBe(true);
    });

    it('ARCHITECTURE_READY fails when components lack requirements_refs', () => {
      saveDesignSpec({
        missionId: 'MSN-D2',
        projectName: 'X',
        extracted: {
          ...designExtracted,
          components: [{ id: 'COMP-1', name: 'x', responsibility: 'y' }],
        },
      });
      const gate = evaluateArchitectureReadyGate('MSN-D2');
      expect(gate.passed).toBe(false);
      expect(gate.reasons.some((r) => r.includes('requirements_refs'))).toBe(true);
    });

    it('ARCHITECTURE_READY fails with blocking open_decisions', () => {
      saveDesignSpec({
        missionId: 'MSN-D3',
        projectName: 'X',
        extracted: {
          ...designExtracted,
          open_decisions: [{ decision: 'DB choice', blocking: true }],
        },
      });
      const gate = evaluateArchitectureReadyGate('MSN-D3');
      expect(gate.passed).toBe(false);
    });

    it('ARCHITECTURE_READY fails when no spec exists', () => {
      expect(evaluateArchitectureReadyGate('MSN-NONE').passed).toBe(false);
    });

    it('emits design specs that satisfy the schema', () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/design-spec.schema.json'));

      const saved = saveDesignSpec({
        missionId: 'MSN-D-SCHEMA',
        projectName: 'Schema Project',
        extracted: designExtracted,
        generatedBy: 'test-suite',
      });

      expect(validate(saved), JSON.stringify(validate.errors || [])).toBe(true);
    });

    it('rejects malformed design specs', () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/design-spec.schema.json'));

      expect(
        validate({
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date().toISOString(),
          components: [],
        }),
      ).toBe(false);
    });
  });

  describe('test plan', () => {
    it('saves and reads a test plan', () => {
      const saved = saveTestPlan({
        missionId: 'MSN-T',
        projectName: 'X',
        extracted: testExtracted,
      });
      expect(saved.cases.length).toBe(1);
      expect(readTestPlan('MSN-T')?.app_id).toBe('sample-app');
    });

    it('QA_READY passes when all must-have requirements are covered', () => {
      saveTestPlan({ missionId: 'MSN-T1', projectName: 'X', extracted: testExtracted });
      expect(evaluateQaReadyGate('MSN-T1', ['FR-1']).passed).toBe(true);
    });

    it('QA_READY fails when a must-have requirement is not covered', () => {
      saveTestPlan({ missionId: 'MSN-T2', projectName: 'X', extracted: testExtracted });
      const gate = evaluateQaReadyGate('MSN-T2', ['FR-1', 'FR-2']);
      expect(gate.passed).toBe(false);
      expect(gate.reasons[0]).toContain('FR-2');
    });
  });

  describe('task plan', () => {
    it('saves and reads a task plan', () => {
      const saved = saveTaskPlan({
        missionId: 'MSN-TP',
        projectName: 'X',
        decomposed,
      });
      expect(saved.tasks.length).toBe(2);
      expect(readTaskPlan('MSN-TP')?.tasks[1].depends_on).toEqual(['T-IMPL-1']);
    });

    it('TASK_PLAN_READY passes on a clean plan', () => {
      saveTaskPlan({ missionId: 'MSN-TP1', projectName: 'X', decomposed });
      expect(evaluateTaskPlanReadyGate('MSN-TP1').passed).toBe(true);
    });

    it('TASK_PLAN_READY fails on unknown dependency', () => {
      saveTaskPlan({
        missionId: 'MSN-TP2',
        projectName: 'X',
        decomposed: {
          tasks: [
            {
              task_id: 'T-X-1',
              title: 'x',
              summary: 'x',
              priority: 'must',
              estimate: 'S',
              test_criteria: ['ok'],
              depends_on: ['T-NOT-EXIST'],
            },
          ],
        },
      });
      const gate = evaluateTaskPlanReadyGate('MSN-TP2');
      expect(gate.passed).toBe(false);
      expect(gate.reasons.some((r) => r.includes('unknown'))).toBe(true);
    });

    it('TASK_PLAN_READY fails on cyclic dependencies', () => {
      saveTaskPlan({
        missionId: 'MSN-TP3',
        projectName: 'X',
        decomposed: {
          tasks: [
            {
              task_id: 'T-A',
              title: 'a',
              summary: 'a',
              priority: 'must',
              estimate: 'S',
              test_criteria: ['ok'],
              depends_on: ['T-B'],
            },
            {
              task_id: 'T-B',
              title: 'b',
              summary: 'b',
              priority: 'must',
              estimate: 'S',
              test_criteria: ['ok'],
              depends_on: ['T-A'],
            },
          ],
        },
      });
      const gate = evaluateTaskPlanReadyGate('MSN-TP3');
      expect(gate.passed).toBe(false);
      expect(gate.reasons.some((r) => r.toLowerCase().includes('cycle'))).toBe(true);
    });

  it('TASK_PLAN_READY fails when must-priority tasks lack test_criteria', () => {
      saveTaskPlan({
        missionId: 'MSN-TP4',
        projectName: 'X',
        decomposed: {
          tasks: [
            {
              task_id: 'T-IMPL-X',
              title: 'x',
              summary: 'x',
              priority: 'must',
              estimate: 'M',
            },
          ],
        },
      });
      const gate = evaluateTaskPlanReadyGate('MSN-TP4');
      expect(gate.passed).toBe(false);
      expect(gate.reasons.some((r) => r.includes('test_criteria'))).toBe(true);
    });

    it('emits task plans that satisfy the schema', () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/task-plan.schema.json'));

      const saved = saveTaskPlan({
        missionId: 'MSN-TP5',
        projectName: 'Schema Project',
        decomposed,
        generatedBy: 'test-suite',
      });

      expect(validate(saved), JSON.stringify(validate.errors || [])).toBe(true);
    });

    it('rejects malformed task plans', () => {
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/task-plan.schema.json'));

      expect(
        validate({
          version: 'v1',
          project_name: 'Broken',
          generated_at: new Date().toISOString(),
          tasks: [],
        }),
      ).toBe(false);
    });
  });
});
