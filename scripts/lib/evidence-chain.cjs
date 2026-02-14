const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pathResolver = require('./path-resolver.cjs');

/**
 * Chain of Evidence: The Blockchain of Artifacts
 * Tracks the lineage of every generated file to ensure full accountability.
 */
const evidenceChain = {
  registryPath: pathResolver.shared('registry/evidence_chain.json'),

  /**
   * Register a new artifact
   * @param {string} filePath - Path to the generated file
   * @param {string} agentId - Who created it?
   * @param {string} parentId - Which evidence/request triggered this? (optional)
   * @param {string} context - "Created via ux-visualizer" etc.
   */
  register: (filePath, agentId, parentId = null, context = '') => {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const id = `EVD-${hash.substring(0, 8).toUpperCase()}`;
    
    const entry = {
      id,
      path: path.relative(pathResolver.activeRoot(), filePath),
      hash,
      agentId,
      parentId,
      context,
      timestamp: new Date().toISOString()
    };

    // Load & Append
    const registry = evidenceChain._loadRegistry();
    // 重複チェック
    if (!registry.chain.find(e => e.hash === hash)) {
      registry.chain.push(entry);
      fs.writeFileSync(evidenceChain.registryPath, JSON.stringify(registry, null, 2));
    }

    return id;
  },

  /**
   * Get lineage of an evidence
   */
  getLineage: (evidenceId) => {
    const registry = evidenceChain._loadRegistry();
    const lineage = [];
    let currentId = evidenceId;

    while (currentId) {
      const entry = registry.chain.find(e => e.id === currentId);
      if (!entry) break;
      lineage.push(entry);
      currentId = entry.parentId;
    }
    return lineage.reverse();
  },

  _loadRegistry: () => {
    if (!fs.existsSync(evidenceChain.registryPath)) {
      if (!fs.existsSync(path.dirname(evidenceChain.registryPath))) {
        fs.mkdirSync(path.dirname(evidenceChain.registryPath), { recursive: true });
      }
      return { chain: [] };
    }
    return JSON.parse(fs.readFileSync(evidenceChain.registryPath, 'utf8'));
  }
};

module.exports = evidenceChain;
