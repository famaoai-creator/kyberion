/** Isolated, synthetic browser identity for first-job integration tests only. */
import * as path from 'node:path';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';

export const FIRST_JOB_TEST_ISSUER = 'https://fixture.example';
export const FIRST_JOB_TEST_SUBJECT = 'fixture-subject';
export const FIRST_JOB_TEST_SESSION_KEY =
  'synthetic-test-session-key-never-used-outside-tests-123456';

/** Copies product policy/schema data, never user profiles or credentials. */
export function seedFirstJobTestRoot(sourceRoot: string, root: string): void {
  const copy = (relative: string): void => {
    const source = path.join(sourceRoot, relative);
    if (!safeExistsSync(source)) return;
    const stat = safeLstat(source);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of safeReaddir(source)) copy(path.join(relative, name));
    } else if (/\.(json|ya?ml)$/.test(relative)) {
      const target = path.join(root, relative);
      safeMkdir(path.dirname(target), { recursive: true });
      safeWriteFile(target, safeReadFile(source, { encoding: 'utf8' }));
    }
  };
  safeMkdir(root, { recursive: true });
  safeWriteFile(path.join(root, 'package.json'), '{}');
  for (const relative of [
    'knowledge/product/schemas',
    'knowledge/product/governance',
    'knowledge/product/orchestration',
    'pipelines/front-desk-request-receipt.json',
    'scripts/pipeline-shell-independence.baseline.json',
  ])
    copy(relative);
}

export function syntheticFirstJobOwner(tenant: string) {
  return {
    member_id: 'owner',
    display_name: 'Synthetic diagnostic owner',
    status: 'active' as const,
    memberships: [{ tenant_slug: tenant, role: 'owner' as const }],
    access_registrations: [],
    external_identities: [{ issuer: FIRST_JOB_TEST_ISSUER, subject: FIRST_JOB_TEST_SUBJECT }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}
