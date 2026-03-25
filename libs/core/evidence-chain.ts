import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { safeWriteFile, safeReadFile, safeExistsSync } from './secure-io.js';

export interface EvidenceQuery {
  missionId?: string;
  agentId?: string;
  type?: string;          // file type filter
  fromDate?: string;      // ISO date
  toDate?: string;        // ISO date
  pathPattern?: string;   // glob-like pattern
  limit?: number;
}

export interface EvidenceEntry {
  evidenceId: string;
  hash: string;
  path: string;
  agentId?: string;
  missionId?: string;
  registeredAt: string;
  metadata?: Record<string, any>;
}

function normalizeEvidenceEntry(entry: any): EvidenceEntry {
  return {
    evidenceId: entry.evidenceId || entry.id || '',
    hash: entry.hash || '',
    path: entry.path || '',
    agentId: entry.agentId,
    missionId: entry.missionId,
    registeredAt: entry.registeredAt || entry.timestamp || '',
    metadata: entry.metadata,
  };
}

/**
 * Chain of Evidence: The Blockchain of Artifacts
 * [SECURE-IO COMPLIANT VERSION]
 */
export const evidenceChain = {
  registryPath: pathResolver.shared('registry/evidence_chain.json'),

  register: (filePath: string, agentId: string, parentId: string | null = null, context = '') => {
    if (!safeExistsSync(filePath)) return null;

    try {
      const content = safeReadFile(filePath, { encoding: null }) as Buffer;
      const hash = createHash('sha256').update(content).digest('hex');
      const id = `EVD-${hash.substring(0, 8).toUpperCase()}`;

      const entry = {
        id,
        path: path.relative(pathResolver.active(), filePath),
        hash,
        agentId,
        parentId,
        context,
        timestamp: new Date().toISOString(),
      };

      const registry = evidenceChain._loadRegistry();
      if (!registry.chain.find((e: any) => e.hash === hash)) {
        registry.chain.push(entry);
        safeWriteFile(evidenceChain.registryPath, JSON.stringify(registry, null, 2));
      }

      return id;
    } catch (err) {
      return null;
    }
  },

  getLineage: (evidenceId: string) => {
    const registry = evidenceChain._loadRegistry();
    const lineage = [];
    let currentId: string | null = evidenceId;

    while (currentId) {
      const entry = registry.chain.find((e: any) => e.id === currentId);
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
    if (!safeExistsSync(evidenceChain.registryPath)) {
      return { chain: [] };
    }
    try {
      const content = safeReadFile(evidenceChain.registryPath, { encoding: 'utf8' }) as string;
      return JSON.parse(content);
    } catch (_) {
      return { chain: [] };
    }
  },
};

/**
 * Query registered evidence entries with filters
 */
export function queryEvidence(query: EvidenceQuery = {}): EvidenceEntry[] {
  const registryPath = evidenceChain.registryPath;
  if (!safeExistsSync(registryPath)) return [];

  const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
  let entries: EvidenceEntry[];
  try {
    const registry = JSON.parse(raw);
    const sourceEntries = Array.isArray(registry) ? registry : (registry.entries || registry.chain || []);
    entries = sourceEntries.map(normalizeEvidenceEntry);
  } catch { return []; }

  // Apply filters
  if (query.missionId) entries = entries.filter(e => e.missionId === query.missionId);
  if (query.agentId) entries = entries.filter(e => e.agentId === query.agentId);
  if (query.type) entries = entries.filter(e => e.path?.endsWith(`.${query.type}`));
  if (query.fromDate) entries = entries.filter(e => e.registeredAt >= query.fromDate!);
  if (query.toDate) entries = entries.filter(e => e.registeredAt <= query.toDate!);
  if (query.pathPattern) {
    const pattern = query.pathPattern.replace(/\*/g, '.*');
    const re = new RegExp(pattern);
    entries = entries.filter(e => re.test(e.path || ''));
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
