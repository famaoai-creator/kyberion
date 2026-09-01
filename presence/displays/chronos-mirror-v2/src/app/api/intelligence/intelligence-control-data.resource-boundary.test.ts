import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { readSafeObservationFile } from './intelligence-control-data';

const suffix = `${process.pid}-${Date.now()}`;
const target = pathResolver.sharedTmp(`intelligence-control-${suffix}.jsonl`);
const link = pathResolver.sharedTmp(`intelligence-control-${suffix}-link.jsonl`);

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(target, { force: true });
    safeRmSync(link, { force: true });
  });
});

describe('intelligence control observation boundary', () => {
  it('reads regular observation files but does not follow symlinks', () => {
    withExecutionContext('mission_controller', () => {
      safeWriteFile(target, '{"event":"safe"}\n');
      expect(readSafeObservationFile(target)).toContain('safe');
      safeSymlinkSync(target, link);
    });

    expect(readSafeObservationFile(link)).toBeNull();
  });
});
