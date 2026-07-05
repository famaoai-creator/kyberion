import { describe, expect, it, vi } from 'vitest';
import { logger } from './core.js';
import {
  CANONICAL_OP_FAMILIES,
  listCanonicalOpFamilies,
  resolveBrowserRecordingPipelineOp,
  normalizeBrowserPipelineOp,
} from './op-vocabulary.js';

describe('op-vocabulary', () => {
  it('normalizes browser recording aliases to canonical pipeline ops', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(resolveBrowserRecordingPipelineOp('click_ref')).toBe('click');
    expect(resolveBrowserRecordingPipelineOp('fill_ref')).toBe('fill');
    expect(resolveBrowserRecordingPipelineOp('snapshot')).toBe('snapshot');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.map((args) => args[0])).toEqual([
      '[op-vocabulary] recording alias "click_ref" is deprecated; use "click" instead.',
      '[op-vocabulary] recording alias "fill_ref" is deprecated; use "fill" instead.',
    ]);
    warnSpy.mockRestore();
  });

  it('normalizes browser pipeline aliases to canonical runtime ops', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(normalizeBrowserPipelineOp('select_ref')).toBe('click');
    expect(normalizeBrowserPipelineOp('submit_form')).toBe('click');
    expect(normalizeBrowserPipelineOp('press_ref')).toBe('press');
    expect(normalizeBrowserPipelineOp('wait_ref')).toBe('wait');
    expect(normalizeBrowserPipelineOp('snapshot')).toBe('snapshot');
    expect(warnSpy).toHaveBeenCalledTimes(4);
    expect(warnSpy.mock.calls.map((args) => args[0])).toEqual([
      '[op-vocabulary] pipeline alias "select_ref" is deprecated; use "click" instead.',
      '[op-vocabulary] pipeline alias "submit_form" is deprecated; use "click" instead.',
      '[op-vocabulary] pipeline alias "press_ref" is deprecated; use "press" instead.',
      '[op-vocabulary] pipeline alias "wait_ref" is deprecated; use "wait" instead.',
    ]);
    warnSpy.mockRestore();
  });

  it('exposes the canonical op families used for AR-04 alignment', () => {
    expect(listCanonicalOpFamilies()).toEqual(CANONICAL_OP_FAMILIES);
    expect(CANONICAL_OP_FAMILIES.io).toContain('write');
    expect(CANONICAL_OP_FAMILIES.core).toContain('notify');
  });
});
