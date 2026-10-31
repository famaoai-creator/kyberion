import { describe, expect, it } from 'vitest';

import { deriveMissionBranchName } from '@agent/core/mission/mission-git';

describe('deriveMissionBranchName', () => {
  it('derives a non-main mission branch name', () => {
    expect(deriveMissionBranchName('PDF-TO-PPTX-CONVERSION')).toBe(
      'mission/pdf-to-pptx-conversion'
    );
  });
});
