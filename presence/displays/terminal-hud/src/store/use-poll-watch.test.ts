import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveWatchPaths } from './use-poll-watch';

const suffix = `${process.pid}-${Date.now()}`;
const target = pathResolver.sharedTmp(`terminal-hud-watch-target-${suffix}.json`);
const linked = pathResolver.sharedTmp(`terminal-hud-watch-linked-${suffix}.json`);

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(target, { force: true });
    safeRmSync(linked, { force: true });
  });
});

describe('resolveWatchPaths', () => {
  it('keeps regular resources and rejects symlink watchers', () => {
    withExecutionContext('mission_controller', () => {
      safeWriteFile(target, '{}');
      safeSymlinkSync(target, linked);

      expect(resolveWatchPaths([target])).toEqual([target]);
      expect(resolveWatchPaths([linked])).toEqual([]);
    });
  });
});
