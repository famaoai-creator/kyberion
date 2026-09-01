import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { normalizePromotionAdvice, resolvePromotionInputPath } from './pipeline_promote.js';

describe('pipeline promotion resource boundaries', () => {
  it('uses the governed parser for model promotion advice', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline_promote.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonInput(jsonText, 'pipeline promotion advice')");
    expect(source).not.toContain('JSON.parse(jsonText)');
  });

  it('rejects external and non-file sources before promotion', () => {
    expect(() => resolvePromotionInputPath('/tmp/pipeline.json')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolvePromotionInputPath('pipelines')).toThrow(
      'source ADF must be an existing regular file'
    );
  });

  it('projects only valid promotion advice entries', () => {
    expect(
      normalizePromotionAdvice({
        name: ' reusable ',
        placeholders: [
          { step_index: 1, param_path: 'params.url', placeholder: 'target_url' },
          { step_index: -1, param_path: 'params.bad', placeholder: 'ignored' },
        ],
        semantic_step_indices: [2, -1, 'bad'],
      })
    ).toEqual({
      name: ' reusable ',
      placeholders: [{ step_index: 1, param_path: 'params.url', placeholder: 'target_url' }],
      semantic_step_indices: [2],
    });
  });

  it('rejects primitive and array promotion advice roots', () => {
    expect(normalizePromotionAdvice(null)).toBeNull();
    expect(normalizePromotionAdvice([])).toBeNull();
    expect(normalizePromotionAdvice('invalid')).toBeNull();
  });
});
