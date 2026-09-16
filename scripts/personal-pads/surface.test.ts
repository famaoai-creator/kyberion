import { describe, expect, it } from 'vitest';
import { createLocalPadContext } from '../lib/local-artifact-pad.js';
import {
  getContent,
  getHistory,
  getMenu,
  getSurfaceContract,
  getTop,
  PERSONAL_PADS_SURFACE,
  resolvePadPolicyId,
} from './surface.js';

describe('personal pads surface seams', () => {
  const context = createLocalPadContext({
    serviceId: 'personal-pads',
    sessionPrefix: 'surface-test',
    artifact_ref: 'local-pads',
    viewer_principal: 'human:alice',
    tier: 'public',
  });

  it('derives menu/content from one contract', () => {
    expect(getMenu()).toHaveLength(8);
    expect(PERSONAL_PADS_SURFACE.getMenu()).toHaveLength(8);
    expect(PERSONAL_PADS_SURFACE.getSurfaceContract().content).toHaveLength(8);
    expect(getContent('meeting-notepad').adapter.id).toBe('meeting-notepad.v1');
    expect(getSurfaceContract().content).toHaveLength(8);
  });

  it('keeps top scope and history access in the application seam', () => {
    expect(getTop(context)).toMatchObject({ title: 'Capture desk', scope: context.scope });
    expect(getHistory(context, 'memory-capture', { limit: 1 })).toMatchObject({
      records: expect.any(Array),
      storage_label: '公開 scope の Memory capture',
    });
  });

  it('resolves the registry-declared policy for each tier', () => {
    expect(resolvePadPolicyId('meeting-notepad', 'confidential')).toBe('pad.confidential.v1');
    expect(resolvePadPolicyId('meeting-notepad', 'public')).toBe('pad.public.v1');
  });
});
