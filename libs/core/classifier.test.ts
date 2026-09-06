import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { classifyFile } from './classifier.js';

const RULES = { policy: ['approval', 'governance'] };

describe('classifyFile resource boundary', () => {
  it('classifies a regular file', () => {
    const filePath = pathResolver.sharedTmp(`classifier-${process.pid}.md`);
    safeWriteFile(filePath, 'approval is required by governance');
    try {
      expect(classifyFile(filePath, RULES)).toMatchObject({ category: 'policy', matches: 2 });
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('rejects a directory before attempting to read it', () => {
    const directoryPath = pathResolver.sharedTmp(`classifier-directory-${process.pid}.md`);
    safeMkdir(directoryPath, { recursive: true });
    try {
      expect(() => classifyFile(directoryPath, RULES)).toThrow(
        '[CLASSIFIER_RESOURCE] classification target must be a regular file'
      );
    } finally {
      safeRmSync(directoryPath, { recursive: true, force: true });
    }
  });
});
