const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Ecosystem Ledger v1.0
 * Provides a centralized, tamper-evident audit trail for all governance events.
 */

const rootDir = path.resolve(__dirname, '../..');
const LEDGER_PATH = path.join(rootDir, 'active/audit/governance-ledger.jsonl');

const ledger = {
  /**
   * Record a governance event
   * @param {string} type - SKILL_EXEC | ACE_DECISION | SUDO_GATE | CONFIG_CHANGE
   * @param {Object} data - Event payload
   */
  record: (type, data) => {
    const timestamp = new Date().toISOString();
    const lastHash = ledger._getLastHash();

    const entry = {
      timestamp,
      type,
      role: data.role || 'Unknown',
      mission_id: data.mission_id || 'None',
      payload: data,
      parent_hash: lastHash,
    };

    // Calculate current hash for immutability (without the hash field itself)
    const hash = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    entry.hash = hash;

    fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
    return hash;
  },

  _getLastHash: () => {
    if (!fs.existsSync(LEDGER_PATH)) return '0'.repeat(64);
    try {
      const content = fs.readFileSync(LEDGER_PATH, 'utf8').trim();
      if (!content) return '0'.repeat(64);
      const lines = content.split('\n');
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      return lastEntry.hash || '0'.repeat(64);
    } catch (_e) {
      return '0'.repeat(64);
    }
  },

  /**
   * Verify the integrity of the entire ledger
   */
  verifyIntegrity: () => {
    if (!fs.existsSync(LEDGER_PATH)) return true;
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n');
    let expectedParentHash = '0'.repeat(64);

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const { hash, ...dataWithoutHash } = entry;

        // Verify parent hash link
        if (entry.parent_hash !== expectedParentHash) return false;

        // Verify current hash (re-calculate using data without hash field)
        const actualHash = crypto
          .createHash('sha256')
          .update(JSON.stringify(dataWithoutHash))
          .digest('hex');
        if (hash !== actualHash) return false;

        expectedParentHash = hash;
      } catch (_e) {
        return false;
      }
    }
    return true;
  },
};

module.exports = ledger;
