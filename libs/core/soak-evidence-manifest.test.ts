import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadSoakEvidenceManifestAtPath,
  writeSoakEvidenceManifestAtPath,
} from './soak-evidence-manifest.js';

const root = pathResolver.sharedTmp(`soak-evidence-manifest-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

const manifest = {
  version: '1.0' as const,
  started_at: '2026-09-03T00:00:00.000Z',
  last_run_at: '2026-09-03T00:00:00.000Z',
  run_count: 1,
  total_cycles: 4,
  window_days_equivalent: 4,
  last_validation: { ok: true, regression_count: 0, issues: [] },
};

describe('soak evidence manifest loader', () => {
  it('validates and reloads a manifest through the shared contract', () => {
    const file = path.join(root, 'manifest.json');
    safeMkdir(root, { recursive: true });

    expect(writeSoakEvidenceManifestAtPath(file, manifest)).toEqual(manifest);
    expect(loadSoakEvidenceManifestAtPath(file)).toEqual(manifest);
  });

  it('rejects malformed manifests before they become cumulative state', () => {
    const file = path.join(root, 'manifest.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ ...manifest, unexpected: true }));

    expect(() => loadSoakEvidenceManifestAtPath(file)).toThrow(
      /Invalid catalog soak-evidence-manifest/u
    );
  });

  it('rejects symlinked manifests before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'manifest.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify(manifest));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadSoakEvidenceManifestAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
