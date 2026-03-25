import { describe, expect, it } from 'vitest';

import { deriveMissionBranchName } from '../scripts/refactor/mission-git.js';

describe('deriveMissionBranchName', () => {
  it('derives a non-main mission branch name', () => {
    expect(deriveMissionBranchName('PDF-TO-PPTX-CONVERSION')).toBe('mission/pdf-to-pptx-conversion');
  });
});
