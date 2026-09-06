import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock dependencies before importing the module under test
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (filePath: string) => filePath,
  safeReadFile: (filePath: string, _opts: any) => {
    return fs.readFileSync(filePath, 'utf8');
  },
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
}));

vi.mock('../foundation/json.js', () => ({
  readJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
}));

vi.mock('../foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
    loadJsonIfPresent: <T>(filePath: string) =>
      fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as T) : null,
    appendFile: (filePath: string, content: string) => fs.appendFileSync(filePath, content),
    exists: (filePath: string) => fs.existsSync(filePath),
    readFile: (filePath: string) => fs.readFileSync(filePath, 'utf8'),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content),
  }),
}));

vi.mock('../core.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { resolveRef, handleStepError } from './pipeline-engine.js';

const TMP_FILE = path.join(process.cwd(), 'active/shared/tmp/test-sub-pipeline.json');

describe('pipeline-engine', () => {
  beforeEach(() => {
    // Clean up temp files before each test
    fs.mkdirSync(path.dirname(TMP_FILE), { recursive: true });
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

      const result = await resolveRef(TMP_FILE, {}, { _refDepth: 0 }, (val: any) => val);

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
        (val: any) => (val === '{{parent_val}}' ? 'resolved_value' : val)
      );

      expect(result.mergedCtx.injected).toBe('resolved_value');
      expect(result.mergedCtx.base).toBe('default');
    });

    it('throws on circular ref (depth > 10)', async () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({ steps: [] }));

      await expect(resolveRef(TMP_FILE, {}, { _refDepth: 10 }, (v: any) => v)).rejects.toThrow(
        'Circular ref or depth exceeded'
      );
    });

    it('throws on missing file', async () => {
      await expect(
        resolveRef(
          'active/shared/tmp/nonexistent-pipeline-xyz.json',
          {},
          { _refDepth: 0 },
          (v: unknown) => v
        )
      ).rejects.toThrow();
    });

    it('rejects a referenced file that is not a valid pipeline ADF', async () => {
      fs.writeFileSync(TMP_FILE, JSON.stringify({ steps: { invalid: true } }));

      await expect(resolveRef(TMP_FILE, {}, {}, (v: unknown) => v)).rejects.toThrow(
        'Invalid pipeline ADF'
      );
    });

    it('rejects refs outside the repository root', async () => {
      await expect(
        resolveRef('/tmp/test-sub-pipeline.json', {}, {}, (v: unknown) => v)
      ).rejects.toThrow('[PIPELINE_SCOPE]');
    });

    it('rejects refs reached through a symbolic link', async () => {
      const target = path.join(path.dirname(TMP_FILE), 'pipeline-target.json');
      const link = path.join(path.dirname(TMP_FILE), 'pipeline-link.json');
      try {
        fs.writeFileSync(target, JSON.stringify({ steps: [] }));
        fs.symlinkSync(target, link);
        await expect(resolveRef(link, {}, { _refDepth: 0 }, (v: unknown) => v)).rejects.toThrow(
          '[PIPELINE_SCOPE]'
        );
      } finally {
        if (fs.existsSync(link)) fs.unlinkSync(link);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
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
        resolveVarsFn
      );

      expect(result.recovered).toBe(true);
      expect(result.ctx._error.message).toBe('step failed');
      expect(result.ctx._error.step_id).toBe('test-step');
    });

    it('with strategy abort re-throws', async () => {
      await expect(
        handleStepError(testError, testStep, { strategy: 'abort' }, testCtx, vi.fn(), resolveVarsFn)
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
        resolveVarsFn
      );

      expect(result.recovered).toBe(true);
      expect(executeSubPipeline).toHaveBeenCalledWith(
        fallbackSteps,
        expect.objectContaining({ _error: expect.any(Object) })
      );
    });

    it('rejects a fallback ref that resolves to a non-string path', async () => {
      await expect(
        handleStepError(
          testError,
          testStep,
          { strategy: 'fallback', ref: '{{fallback_ref}}' },
          testCtx,
          vi.fn(),
          () => ({ invalid: true })
        )
      ).rejects.toThrow('fallback ref must resolve to a non-empty string');
    });
  });
});
