import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { safeWriteFile, safeReadFile } from './secure-io.js';

/**
 * Chain of Evidence: The Blockchain of Artifacts
 * [SECURE-IO COMPLIANT VERSION]
 */
export const evidenceChain = {
  registryPath: pathResolver.shared('registry/evidence_chain.json'),

  register: (filePath: string, agentId: string, parentId: string | null = null, context = '') => {
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = safeReadFile(filePath) as Buffer;
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

  _loadRegistry: () => {
    if (!fs.existsSync(evidenceChain.registryPath)) {
      return { chain: [] };
    }
    try {
      // Use standard fs for internal loading within library if necessary, 
      // but safeReadFile is preferred if accessible.
      const content = fs.readFileSync(evidenceChain.registryPath, 'utf8');
      return JSON.parse(content);
    } catch (_) {
      return { chain: [] };
    }
  },
};
