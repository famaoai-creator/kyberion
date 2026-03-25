import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock dependencies before importing the module under test
vi.mock('../secure-io.js', () => ({
  safeReadFile: (filePath: string, _opts: any) => {
    return fs.readFileSync(filePath, 'utf8');
  },
}));

vi.mock('../core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { resolveRef, handleStepError } from './pipeline-engine.js';

const TMP_FILE = '/tmp/test-sub-pipeline.json';

describe('pipeline-engine', () => {
  beforeEach(() => {
    // Clean up temp files before each test
    if (fs.existsSync(TMP_FILE)) {
      fs.unlinkSync(TMP_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TMP_FILE)) {
      fs.unlinkSync(TMP_FILE);
    }
  });

  describe('resolveRef', () => {
    it('loads a valid JSON file and returns steps + merged context', async () => {
      const subPipeline = {
        steps: [{ id: 'step1', op: 'log', params: { message: 'hello' } }],
        context: { foo: 'bar' },
      };
      fs.writeFileSync(TMP_FILE, JSON.stringify(subPipeline));

      const result = await resolveRef(
        TMP_FILE,
        {},
        { _refDepth: 0 },
        (val: any) => val,
      );

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].id).toBe('step1');
      expect(result.mergedCtx.foo).toBe('bar');
      expect(result.mergedCtx._refDepth).toBe(1);
    });

    it('with bind params injects variables into context', async () => {
      const subPipeline = {
        steps: [{ id: 'step1', op: 'log' }],
        context: { base: 'default' },
      };
      fs.writeFileSync(TMP_FILE, JSON.stringify(subPipeline));

      const result = await resolveRef(
        TMP_FILE,
        { injected: '{{parent_val}}' },
        { _refDepth: 0 },
        (val: any) => (val === '{{parent_val}}' ? 'resolved_value' : val),
      );

      expect(result.mergedCtx.injected).toBe('resolved_value');
      expect(result.mergedCtx.base).toBe('default');
    });

    it('throws on circular ref (depth > 10)', async () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({ steps: [] }));

      await expect(
        resolveRef(TMP_FILE, {}, { _refDepth: 10 }, (v: any) => v),
      ).rejects.toThrow('Circular ref or depth exceeded');
    });

    it('throws on missing file', async () => {
      await expect(
        resolveRef('/tmp/nonexistent-pipeline-xyz.json', {}, { _refDepth: 0 }, (v: any) => v),
      ).rejects.toThrow();
    });
  });

  describe('handleStepError', () => {
    const testError = new Error('step failed');
    const testStep = { id: 'test-step', op: 'click' };
    const testCtx = { some: 'context' };
    const resolveVarsFn = (v: any) => v;

    it('with strategy skip returns recovered: true', async () => {
      const result = await handleStepError(
        testError,
        testStep,
        { strategy: 'skip' },
        testCtx,
        vi.fn(),
        resolveVarsFn,
      );

      expect(result.recovered).toBe(true);
      expect(result.ctx._error.message).toBe('step failed');
      expect(result.ctx._error.step_id).toBe('test-step');
    });

    it('with strategy abort re-throws', async () => {
      await expect(
        handleStepError(
          testError,
          testStep,
          { strategy: 'abort' },
          testCtx,
          vi.fn(),
          resolveVarsFn,
        ),
      ).rejects.toThrow('step failed');
    });

    it('with strategy fallback executes fallback steps', async () => {
      const fallbackSteps = [{ id: 'fallback1', op: 'log' }];
      const executeSubPipeline = vi.fn().mockResolvedValue({ recovered: true, fallback: 'done' });

      const result = await handleStepError(
        testError,
        testStep,
        { strategy: 'fallback', fallback: fallbackSteps },
        testCtx,
        executeSubPipeline,
        resolveVarsFn,
      );

      expect(result.recovered).toBe(true);
      expect(executeSubPipeline).toHaveBeenCalledWith(
        fallbackSteps,
        expect.objectContaining({ _error: expect.any(Object) }),
      );
    });
  });
});
