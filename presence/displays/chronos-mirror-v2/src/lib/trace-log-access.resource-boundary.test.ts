import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveSafeTraceLogPath } from './trace-log-access';

const traceRoot = pathResolver.shared('logs/traces');
const fixtureName = `trace-boundary-${process.pid}-${Date.now()}`;
const targetPath = pathResolver.sharedTmp(`${fixtureName}.jsonl`);
const linkedPath = path.join(traceRoot, `${fixtureName}.jsonl`);

afterEach(() => {
  safeRmSync(linkedPath, { force: true });
  safeRmSync(targetPath, { force: true });
});

describe('trace log resource boundaries', () => {
  it('rejects a symlink inside the allowed trace root', () => {
    safeWriteFile(targetPath, `${JSON.stringify({ traceId: 'linked' })}\n`);
    safeSymlinkSync(targetPath, linkedPath);

    expect(resolveSafeTraceLogPath(linkedPath)).toBeNull();
  });
});
