import { describe, expect, it } from 'vitest';
import {
  CANONICAL_OP_FAMILIES,
  listCanonicalOpFamilies,
  resolveBrowserRecordingPipelineOp,
} from './op-vocabulary.js';

describe('op-vocabulary', () => {
  it('normalizes browser recording aliases to canonical pipeline ops', () => {
    expect(resolveBrowserRecordingPipelineOp('click_ref')).toBe('click');
    expect(resolveBrowserRecordingPipelineOp('fill_ref')).toBe('fill');
    expect(resolveBrowserRecordingPipelineOp('submit_form')).toBe('click');
    expect(resolveBrowserRecordingPipelineOp('snapshot')).toBe('snapshot');
  });

  it('exposes the canonical op families used for AR-04 alignment', () => {
    expect(listCanonicalOpFamilies()).toEqual(CANONICAL_OP_FAMILIES);
    expect(CANONICAL_OP_FAMILIES.io).toContain('write');
    expect(CANONICAL_OP_FAMILIES.core).toContain('notify');
  });
});
