import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadMissionTicketDispatchManifestAtPath } from './mission-ticket-dispatch-manifest.js';

const root = pathResolver.sharedTmp(`mission-ticket-dispatch-manifest-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

const manifest = {
  mission_id: 'MSN-TICKET-MANIFEST',
  records: [
    {
      task_id: 'task-1',
      status: 'failed',
      notes: ['missing assigned_to.agent_id'],
    },
  ],
};

describe('mission ticket dispatch manifest loader', () => {
  it('loads a schema-valid manifest', () => {
    const file = path.join(root, 'dispatch-manifest.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify(manifest));

    expect(loadMissionTicketDispatchManifestAtPath(file)).toEqual(manifest);
  });

  it('rejects malformed manifests before retrospective consumers use them', () => {
    const file = path.join(root, 'dispatch-manifest.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ ...manifest, records: 'invalid' }));

    expect(() => loadMissionTicketDispatchManifestAtPath(file)).toThrow(
      /Invalid catalog mission-ticket-dispatch-manifest/u
    );
  });

  it('rejects symlinked manifests before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'dispatch-manifest.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify(manifest));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadMissionTicketDispatchManifestAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
