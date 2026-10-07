import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import * as registry from '../organization/tenant-registry.js';
import { findRepoDotCharter, type DotCharter } from './dot-charter.js';

const root = pathResolver.sharedTmp('repo-dot-reader-' + process.pid);
const charter: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'diagnostic',
  version: '1.0.0',
  title: 'Synthetic fixture',
  purpose: 'Read-only fixture',
  status: 'active',
  scope: { tier: 'public', tenant_slug: 'fixture-tenant' },
  goal: { statement: 'Read-only fixture' },
  attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'fixture-diagnostic' },
};
function write(relative: string, value: unknown) {
  const file = path.join(root, relative);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value));
  return file;
}
afterEach(() => {
  vi.restoreAllMocks();
  safeRmSync(root, { recursive: true, force: true });
});
describe('repo-only charter ownership', () => {
  it('resolves the repo owner without tenant registry, overlay, or confidential reads', () => {
    const own = write('dots/own.json', charter);
    write('knowledge/confidential/foreign/dots/duplicate.json', {
      ...charter,
      scope: { tier: 'confidential', tenant_slug: 'foreign' },
    });
    const enumerate = vi.spyOn(registry, 'listTenantProfileSlugs').mockImplementation(() => {
      throw Error('must not enumerate');
    });
    const resolve = vi.spyOn(registry, 'resolveTenant').mockImplementation(() => {
      throw Error('must not resolve');
    });
    expect(findRepoDotCharter(charter.dot_id, root)?.path).toBe(own);
    expect(findRepoDotCharter('missing', root)).toBeUndefined();
    expect(enumerate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('isolates a known unrelated invalid schema but fails closed on an invalid target identity', () => {
    write('dots/one.json', charter);
    write('dots/other.json', { dot_id: 'unrelated', kind: 'invalid' });
    expect(findRepoDotCharter(charter.dot_id, root)?.charter.dot_id).toBe(charter.dot_id);
    write('dots/other.json', { dot_id: charter.dot_id, kind: 'invalid' });
    expect(() => findRepoDotCharter(charter.dot_id, root)).toThrow();
  });
  it('rejects a duplicate repo identity rather than choosing a file or tenant fallback', () => {
    write('dots/one.json', charter);
    write('dots/two.json', charter);
    expect(() => findRepoDotCharter(charter.dot_id, root)).toThrow(
      'repo_dot_charter_identity_ambiguous'
    );
  });
  it('treats a missing repo directory as missing without tenant fallback', () => {
    write('knowledge/confidential/foreign/dots/only.json', {
      ...charter,
      scope: { tier: 'confidential', tenant_slug: 'foreign' },
    });
    const enumerate = vi.spyOn(registry, 'listTenantProfileSlugs');
    expect(findRepoDotCharter(charter.dot_id, root)).toBeUndefined();
    expect(enumerate).not.toHaveBeenCalled();
  });
  it('rejects symlinked repo directories and charter files', () => {
    const target = write('other/own.json', charter);
    safeSymlinkSync(path.dirname(target), path.join(root, 'dots'));
    expect(() => findRepoDotCharter(charter.dot_id, root)).toThrow();
    safeRmSync(path.join(root, 'dots'), { force: true });
    safeMkdir(path.join(root, 'dots'), { recursive: true });
    safeSymlinkSync(target, path.join(root, 'dots/own.json'));
    expect(() => findRepoDotCharter(charter.dot_id, root)).toThrow();
  });
});
