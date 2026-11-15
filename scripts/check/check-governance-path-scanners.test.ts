import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { readGovernancePathScannerTextFile } from './check-governance-path-scanners.js';

describe('governance path scanners', () => {
  it('rejects a directory before reading scanned content', () => {
    expect(() => readGovernancePathScannerTextFile(pathResolver.rootResolve('knowledge'))).toThrow(
      'must be a regular file'
    );
  });
});
