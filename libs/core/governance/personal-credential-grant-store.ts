/** Typed personal adapter of the canonical standing-grant store; not a permission source. */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, storagePartitionSegments } from '../storage-layout.js';
import { GrantError, validatePersonalCredentialGrantRecord } from './grant-store.js';
import type { PersonalCredentialGrantRecord } from './personal-credential-grant-scope.js';

/** Same registered grants root, personal/shared partition; no directory discovery API. */
export function personalCredentialGrantRecordPath(grantId: string): string {
  if (!/^GRT-\d{8}-[a-f0-9]{12}$/.test(grantId))
    throw new GrantError('invalid_input', 'invalid grant id');
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      path.posix.join(
        PARTITIONED_RUNTIME_STATE_ROOTS.grants,
        ...storagePartitionSegments({ kind: 'tier', tier: 'personal' }),
        `${grantId}.json`
      )
    ),
    { allowMissingLeaf: true }
  );
}

function personalGrantFile<T>(
  ownerRef: string,
  grantId: string,
  write: boolean,
  run: (file: string) => T
): T {
  if (!/^user:[a-z][a-z0-9-]*$/.test(ownerRef))
    throw new GrantError('invalid_input', 'invalid owner');
  const file = personalCredentialGrantRecordPath(grantId);
  const relative = path.relative(pathResolver.rootResolve(''), file).replaceAll('\\', '/');
  const directory = path.posix.dirname(relative);
  const ancestors = [directory];
  for (
    let parent = path.posix.dirname(directory);
    parent !== '.';
    parent = path.posix.dirname(parent)
  )
    ancestors.push(parent);
  return runInResourceAccessScope(
    {
      custody: { kind: 'person', ref: ownerRef.slice(5) },
      readExact: [relative],
      writeExact: write ? [relative] : [],
      mkdirExact: write ? ancestors : [],
      metadataExact: [relative, ...ancestors],
      allowProductKnowledgeRead: true,
    },
    () => run(file)
  );
}

export function loadPersonalCredentialGrantRecord(
  ownerRef: string,
  grantId: string
): PersonalCredentialGrantRecord | null {
  try {
    const raw = personalGrantFile(ownerRef, grantId, false, (file) =>
      readJsonIfPresent<unknown>(file)
    );
    if (!validatePersonalCredentialGrantRecord(raw).valid) return null;
    const record = raw as PersonalCredentialGrantRecord;
    return record.grant_id === grantId && record.custody.ref === ownerRef.slice(5) ? record : null;
  } catch {
    return null;
  }
}

/** Canonical serializer used only after the personal facade's approval checks. */
export function writePersonalCredentialGrantRecord(record: PersonalCredentialGrantRecord): void {
  const checked = validatePersonalCredentialGrantRecord(record);
  if (!checked.valid) throw new GrantError('invalid_input', checked.errors.join('; '));
  personalGrantFile(record.scope.owner_ref, record.grant_id, true, (file) => {
    safeMkdir(path.dirname(file), { recursive: true });
    writeJson(file, record);
  });
}

export function newPersonalCredentialGrantId(now: Date): string {
  return `GRT-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(6).toString('hex')}`;
}
