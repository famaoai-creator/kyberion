import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '../secure-io.js';
import * as json from '../foundation/json.js';
import * as approvals from '../governance/approval-request-create.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { approvalStoreRoots } from '../governance/approval-store-paths.js';
import {
  decideApprovalRequest,
  loadApprovalRequest,
  listApprovalRequests,
} from '../governance/approval-store.js';
import {
  installPluginManaged,
  listManagedPlugins,
  refreshManagedPluginActivation,
  isManagedPluginActivationAllowed,
} from './plugin-managed-install.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  withExecutionContext('mission_controller', () => {
    for (const root of roots.splice(0)) io.safeRmSync(root);
  });
});
function fixture() {
  const root = pathResolver.sharedTmp(`vitest-plugin-publication-${randomUUID()}`);
  roots.push(root);
  const source = path.join(root, 'source');
  const managedRoot = path.join(root, 'managed');
  io.safeMkdir(source, { recursive: true });
  const params = {
    pluginId: 'transactional',
    sourcePath: source,
    managedRoot,
    requestedBy: 'publication-test',
    approvalChannel: `publication-${randomUUID()}`,
  };
  for (const root of [approvalStoreRoots().coordination, approvalStoreRoots().observability])
    roots.push(pathResolver.rootResolve(`${root}/${params.approvalChannel}`));
  const update = (version: string) => {
    io.safeWriteFile(
      path.join(source, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'transactional', version })
    );
    io.safeWriteFile(path.join(source, 'code.txt'), version);
  };
  update('1.0.0');
  const previous = installPluginManaged(params);
  const target = path.join(managedRoot, 'transactional');
  const recordPath = path.join(target, '.kyberion-managed-plugin.json');
  const previousRecord = io.safeReadFile(recordPath, { encoding: 'utf8' });
  update('2.0.0');
  const retained = () => {
    expect(io.safeReadFile(path.join(target, 'code.txt'), { encoding: 'utf8' })).toBe('1.0.0');
    expect(io.safeReadFile(recordPath, { encoding: 'utf8' })).toBe(previousRecord);
    expect(listManagedPlugins(managedRoot).map((p) => p.pluginId)).toEqual(['transactional']);
  };
  return { params, target, recordPath, previous, retained };
}

describe('managed plugin publication', () => {
  it.each(['approval', 'record', 'publish', 'commit'])(
    'retains old code and approval metadata when %s fails',
    (phase) => {
      const f = fixture();
      if (phase === 'approval')
        vi.spyOn(approvals, 'createApprovalRequest').mockImplementationOnce(() => {
          throw new Error('injected approval failure');
        });
      if (phase === 'record') {
        const write = io.safeWriteFile;
        vi.spyOn(io, 'safeWriteFile').mockImplementation((file, content, options) => {
          if (String(file).endsWith('.kyberion-managed-plugin.json')) {
            throw new Error('injected metadata failure');
          }
          return write(file, content, options);
        });
      }
      if (phase === 'commit') {
        const write = json.writeJson;
        vi.spyOn(json, 'writeJson').mockImplementation((file, value, options) => {
          if (
            String(file).endsWith('journal.json') &&
            value &&
            typeof value === 'object' &&
            'phase' in value &&
            value.phase === 'committed'
          ) {
            throw new Error('injected metadata failure');
          }
          return write(file, value, options);
        });
      }
      if (phase === 'publish') {
        const move = io.safeMoveSync;
        vi.spyOn(io, 'safeMoveSync').mockImplementation((source, target) => {
          if (source.endsWith('/candidate') && target === f.target)
            throw new Error('injected rename failure');
          return move(source, target);
        });
      }
      expect(() => installPluginManaged(f.params)).toThrow('injected');
      vi.restoreAllMocks();
      f.retained();
    }
  );

  it('recovers an interrupted rollback from the durable journal before preparing another update', () => {
    const f = fixture();
    const move = io.safeMoveSync;
    vi.spyOn(io, 'safeMoveSync').mockImplementation((source, target) => {
      if (target === f.target && (source.endsWith('/candidate') || source.endsWith('/previous')))
        throw new Error('injected interruption');
      return move(source, target);
    });
    expect(() => installPluginManaged(f.params)).toThrow('interruption');
    expect(io.safeExistsSync(f.target)).toBe(false);
    vi.restoreAllMocks();
    expect(() =>
      installPluginManaged({
        ...f.params,
        onPermissionsResolved: () => {
          f.retained();
          throw new Error('stop after recovery');
        },
      })
    ).toThrow('stop after recovery');
    f.retained();
  });

  it('rejects an update if installed code changes during preparation without deleting those new bytes', () => {
    const f = fixture();
    expect(() =>
      installPluginManaged({
        ...f.params,
        onPermissionsResolved: () => {
          io.safeWriteFile(path.join(f.target, 'code.txt'), 'independent edit');
        },
      })
    ).toThrow('PLUGIN_PUBLICATION_CONFLICT');
    expect(io.safeReadFile(path.join(f.target, 'code.txt'), { encoding: 'utf8' })).toBe(
      'independent edit'
    );
    expect(
      JSON.parse(io.safeReadFile(f.recordPath, { encoding: 'utf8' }) as string).approvalRequestId
    ).toBe(f.previous.approvalRequestId);
  });

  it('binds the new code to its own approval and never inherits the old approval', () => {
    const f = fixture();
    const pending = loadApprovalRequest(f.params.approvalChannel, f.previous.approvalRequestId!)!;
    decideApprovalRequest('mission_controller', {
      channel: f.params.approvalChannel,
      requestId: pending.id,
      decision: 'approved',
      decidedBy: 'human:operator',
      decidedByType: 'human',
      authMethod: 'surface_session',
      authenticated: true,
      payloadHash: pending.accountability?.payloadHash,
      effectBinding: pending.accountability?.effectBinding,
    });
    expect(
      isManagedPluginActivationAllowed(
        refreshManagedPluginActivation(f.params.pluginId, f.params.managedRoot)!
      )
    ).toBe(true);
    const next = installPluginManaged(f.params);
    expect(next.contentDigest).not.toBe(f.previous.contentDigest);
    expect(next.approvalRequestId).not.toBe(f.previous.approvalRequestId);
    expect(next.activationStatus).toBe('pending_approval');
    expect(listManagedPlugins(f.params.managedRoot)).toHaveLength(1);
    expect(isManagedPluginActivationAllowed(next)).toBe(false);
  });

  it('keeps a failed publication approval unapplied and reuses it only for the identical candidate digest', () => {
    const f = fixture();
    const move = io.safeMoveSync;
    vi.spyOn(io, 'safeMoveSync').mockImplementation((source, target) => {
      if (source.endsWith('/candidate') && target === f.target)
        throw new Error('injected publication failure');
      return move(source, target);
    });
    expect(() => installPluginManaged(f.params)).toThrow('publication failure');
    vi.restoreAllMocks();
    f.retained();
    const request = listApprovalRequests(f.params.approvalChannel).find(
      (row) => row.id !== f.previous.approvalRequestId
    )!;
    expect(request.status).toBe('pending');
    expect(request.applyResult).toBeUndefined();
    const retried = installPluginManaged(f.params);
    expect(retried.approvalRequestId).toBe(request.id);
    expect(retried.activationStatus).toBe('pending_approval');
    expect(isManagedPluginActivationAllowed(retried)).toBe(false);
  });

  it('retains an existing install when the replacement manifest is malformed', () => {
    const f = fixture();
    io.safeWriteFile(path.join(f.params.sourcePath, 'plugin-manifest.json'), '{not JSON');
    expect(() => installPluginManaged(f.params)).toThrow('PLUGIN_UPDATE_MANIFEST_INVALID');
    f.retained();
  });
});
