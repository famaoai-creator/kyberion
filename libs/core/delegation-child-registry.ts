import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { knowledge, pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export const DELEGATION_CHILDREN_REGISTRY_SUBPATH = 'runtime/delegation-children.json';

export interface DelegationChildRecord {
  id: string;
  provider: string;
  pid?: number | null;
  startedAt: string;
  deadlineAt: string;
  budgetMs: number;
  /** OS process start time, used to prevent PID-reuse kills after a restart. */
  pidStartedAt?: string;
}

const DELEGATION_CHILDREN_SCHEMA_PATH = knowledge(
  'product/schemas/delegation-children.schema.json'
);

function delegationChildrenCatalog(filePath: string) {
  return defineCatalog<DelegationChildRecord[]>({
    id: 'delegation-children-registry',
    path: filePath,
    schema: DELEGATION_CHILDREN_SCHEMA_PATH,
  });
}

export function delegationChildrenRegistryPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH), {
    allowMissingLeaf: true,
  });
}

/** Load the active child registry through one schema and repository boundary. */
export function loadDelegationChildrenRegistryAtPath(
  filePath = delegationChildrenRegistryPath()
): DelegationChildRecord[] {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return [];
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DELEGATION_CHILDREN_INVALID] registry must be a regular file: ${filePath}`);
  }
  return delegationChildrenCatalog(safeFilePath).load();
}

/** Validate a registry snapshot before a producer publishes it. */
export function validateDelegationChildrenRegistry(
  records: unknown,
  sourcePath = '<delegation-children-registry>'
): DelegationChildRecord[] {
  return delegationChildrenCatalog(sourcePath).validate(records, sourcePath);
}

/** Validate and persist the active child registry through the same contract. */
export function writeDelegationChildrenRegistryAtPath(
  records: DelegationChildRecord[],
  filePath = delegationChildrenRegistryPath()
): void {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = validateDelegationChildrenRegistry(records, safeFilePath);
  safeMkdir(path.dirname(safeFilePath), { recursive: true });
  safeWriteFile(safeFilePath, JSON.stringify(validated, null, 2), { encoding: 'utf8' });
}
