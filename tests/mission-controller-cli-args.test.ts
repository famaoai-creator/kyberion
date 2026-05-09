import { describe, expect, it } from 'vitest';

import { extractMissionControllerPositionalArgs } from '../scripts/refactor/mission-cli-args.js';

describe('extractMissionControllerPositionalArgs', () => {
  it('skips persona and other value flags from positional args', () => {
    const argv = [
      'node',
      'scripts/mission_controller.ts',
      'create',
      'PDF-TO-PPTX-CONVERSION',
      'confidential',
      '--persona',
      'media_specialist',
      '--tenant-id',
      'tenant-a',
      '--vision-ref',
      '/customer/demo/my-vision.md',
      '--project-id',
      'proj-123',
    ];

    expect(extractMissionControllerPositionalArgs(argv)).toEqual([
      'create',
      'PDF-TO-PPTX-CONVERSION',
      'confidential',
    ]);
  });
});
