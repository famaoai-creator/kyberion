import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeWriteFile,
  safeReadFile,
  safeExistsSync,
} from './secure-io.js';

export interface EvidenceQuery {
  missionId?: string;
  agentId?: string;
  type?: string; // file type filter
  fromDate?: string; // ISO date
  toDate?: string; // ISO date
  pathPattern?: string; // glob-like pattern
  limit?: number;
}

export interface EvidenceEntry {
  evidenceId: string;
  hash: string;
  path: string;
  agentId?: string;
  missionId?: string;
  parentId?: string | null;
  registeredAt: string;
  metadata?: Record<string, unknown>;
}

interface EvidenceRegistry {
  chain: unknown[];
}

const EVIDENCE_CHAIN_REGISTRY_PATH = pathResolver.shared('registry/evidence_chain.json');
const evidenceChainCatalog = defineCatalog<EvidenceRegistry | unknown[]>({
  id: 'evidence-chain-registry',
  path: EVIDENCE_CHAIN_REGISTRY_PATH,
  schema: pathResolver.knowledge('product/schemas/evidence-chain-registry.schema.json'),
});

function evidenceChainCatalogAtPath(filePath: string) {
  return filePath === EVIDENCE_CHAIN_REGISTRY_PATH
    ? evidenceChainCatalog
    : defineCatalog<EvidenceRegistry | unknown[]>({
        id: 'evidence-chain-registry',
        path: filePath,
        schema: pathResolver.knowledge('product/schemas/evidence-chain-registry.schema.json'),
      });
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeEvidenceEntry(entry: unknown): EvidenceEntry | null {
  const record = recordField(entry);
  const evidenceId = stringField(record, 'evidenceId') || stringField(record, 'id');
  const hash = stringField(record, 'hash');
  const evidencePath = stringField(record, 'path');
  const registeredAt = stringField(record, 'registeredAt') || stringField(record, 'timestamp');
  if (!evidenceId || !hash || !evidencePath || !registeredAt) return null;
  return {
    evidenceId,
    hash,
    path: evidencePath,
    agentId: stringField(record, 'agentId'),
    missionId: stringField(record, 'missionId'),
    parentId: stringField(record, 'parentId') || null,
    registeredAt,
    metadata: recordField(record.metadata),
  };
}

function registryEntries(value: unknown): unknown[] {
  const record = recordField(value);
  return Array.isArray(value)
    ? value
    : Array.isArray(record.chain)
      ? record.chain
      : Array.isArray(record.entries)
        ? record.entries
        : [];
}

function normalizeRegistry(value: unknown): EvidenceRegistry {
  return { chain: registryEntries(value) };
}

/** Load the shared evidence registry through its envelope contract. */
export function loadEvidenceChainRegistryAtPath(
  filePath = EVIDENCE_CHAIN_REGISTRY_PATH
): EvidenceRegistry {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return { chain: [] };
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[EVIDENCE_CHAIN] registry must be a regular file: ${filePath}`);
  }
  return normalizeRegistry(evidenceChainCatalogAtPath(safeFilePath).load());
}

/**
 * Chain of Evidence: The Blockchain of Artifacts
 * [SECURE-IO COMPLIANT VERSION]
 */
export const evidenceChain = {
  registryPath: EVIDENCE_CHAIN_REGISTRY_PATH,

  register: (filePath: string, agentId: string, parentId: string | null = null, context = '') => {
    try {
      const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
      if (!safeExistsSync(safeFilePath)) return null;
      const content = safeReadFile(safeFilePath, { encoding: null }) as Buffer;
      const hash = createHash('sha256').update(content).digest('hex');
      const id = `EVD-${hash.substring(0, 8).toUpperCase()}`;

      const entry = {
        id,
        path: path.relative(pathResolver.active(), safeFilePath),
        hash,
        agentId,
        parentId,
        context,
        timestamp: nowIso(),
      };

      const registry = evidenceChain._loadRegistry();
      if (!registry.chain.some((candidate) => normalizeEvidenceEntry(candidate)?.hash === hash)) {
        registry.chain.push(entry);
        safeWriteFile(
          assertSafeRepositoryPath(evidenceChain.registryPath, { allowMissingLeaf: true }),
          JSON.stringify(registry, null, 2)
        );
      }

      return id;
    } catch (err) {
      return null;
    }
  },

  getLineage: (evidenceId: string) => {
    const registry = evidenceChain._loadRegistry();
    const lineage: EvidenceEntry[] = [];
    let currentId: string | null = evidenceId;

    while (currentId) {
      const entry = registry.chain
        .map((candidate) => normalizeEvidenceEntry(candidate))
        .find((candidate): candidate is EvidenceEntry => candidate?.evidenceId === currentId);
      if (!entry) break;
      lineage.push(entry);
      currentId = entry.parentId;
    }
    return lineage.reverse();
  },

  query: (query: EvidenceQuery = {}): EvidenceEntry[] => {
    return queryEvidence(query);
  },

  summarize: (missionId: string) => {
    return summarizeEvidence(missionId);
  },

  _loadRegistry: () => {
    try {
      const safeRegistryPath = assertSafeRepositoryPath(evidenceChain.registryPath, {
        allowMissingLeaf: true,
      });
      if (!safeExistsSync(safeRegistryPath)) return { chain: [] };
      return loadEvidenceChainRegistryAtPath(safeRegistryPath);
    } catch (_) {
      return { chain: [] };
    }
  },
};

/**
 * Query registered evidence entries with filters
 */
export function queryEvidence(query: EvidenceQuery = {}): EvidenceEntry[] {
  let entries: EvidenceEntry[];
  try {
    const registryPath = assertSafeRepositoryPath(evidenceChain.registryPath, {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(registryPath)) return [];
    entries = loadEvidenceChainRegistryAtPath(registryPath)
      .chain.map((entry) => normalizeEvidenceEntry(entry))
      .filter((entry): entry is EvidenceEntry => entry !== null);
  } catch {
    return [];
  }

  // Apply filters
  if (query.missionId) entries = entries.filter((e) => e.missionId === query.missionId);
  if (query.agentId) entries = entries.filter((e) => e.agentId === query.agentId);
  if (query.type) entries = entries.filter((e) => e.path?.endsWith(`.${query.type}`));
  if (query.fromDate) entries = entries.filter((e) => e.registeredAt >= query.fromDate!);
  if (query.toDate) entries = entries.filter((e) => e.registeredAt <= query.toDate!);
  if (query.pathPattern) {
    const pattern = query.pathPattern.replace(/\*/g, '.*');
    const re = new RegExp(pattern);
    entries = entries.filter((e) => re.test(e.path || ''));
  }
  if (query.limit) entries = entries.slice(0, query.limit);

  return entries;
}

/**
 * Generate a summary report of evidence for a mission
 */
export function summarizeEvidence(missionId: string): {
  total: number;
  byType: Record<string, number>;
  dateRange: { from?: string; to?: string };
  entries: EvidenceEntry[];
} {
  const entries = queryEvidence({ missionId });
  const byType: Record<string, number> = {};
  for (const e of entries) {
    const ext = (e.path || '').split('.').pop() || 'unknown';
    byType[ext] = (byType[ext] || 0) + 1;
  }
  return {
    total: entries.length,
    byType,
    dateRange: {
      from: entries.length > 0 ? entries[0].registeredAt : undefined,
      to: entries.length > 0 ? entries[entries.length - 1].registeredAt : undefined,
    },
    entries,
  };
}
