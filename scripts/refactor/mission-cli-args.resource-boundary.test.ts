import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { extractFileRelationshipsOption } from './mission-cli-args.js';

const TEST_ROOT = pathResolver.sharedTmp(`mission-cli-args-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('mission CLI relationship file boundary', () => {
  it('rejects a relationship file outside the repository before reading it', () => {
    expect(() =>
      extractFileRelationshipsOption(['--relationships-file', '/tmp/external-relationships.json'])
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
