const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');

/**
 * ACE (Autonomous Consensus Engine) Core Utility
 */
const aceCore = {
  /**
   * Calculate SHA-256 hash of a string
   */
  calculateHash: (text) => {
    return crypto.createHash('sha256').update(text).digest('hex');
  },

  /**
   * Append a signed thought to the minutes with hash chaining
   */
  appendThought: (minutesPath, role, thought, metadata = {}) => {
    let content = '';
    if (fs.existsSync(minutesPath)) {
      content = fs.readFileSync(minutesPath, 'utf8');
    }

    // Calculate previous hash (last 1000 chars to ensure context)
    const prevHash = aceCore.calculateHash(content);
    const timestamp = new Date().toISOString();
    
    const entryHeader = `
### [${role}] @${timestamp} | PREV_HASH: ${prevHash.substring(0, 8)} | HASH: `;
    const entryBody = `
> ${thought}
`;
    
    // Calculate hash of the new entry itself
    const entryHash = aceCore.calculateHash(entryHeader + entryBody);
    const finalEntry = entryHeader + entryHash.substring(0, 8) + entryBody;

    fs.appendFileSync(minutesPath, finalEntry);
    return entryHash;
  },

  /**
   * Validate the integrity of the hash chain in the minutes
   */
  validateIntegrity: (minutesPath) => {
    // TODO: Implement full chain validation logic
    return true; 
  },

  /**
   * Logic for Decision Matrix
   * @param {Array} votes - Array of { role, securityScore(S1-4), urgencyScore(U1-4), comment }
   */
  evaluateDecision: (votes) => {
    const securityRisk = votes.find(v => v.securityScore === 'S1');
    const highUrgency = votes.some(v => v.urgencyScore === 'U1');

    if (securityRisk) {
      return { 
        decision: 'NO-GO', 
        reason: `Critical Security Risk (S1) detected by ${securityRisk.role}.`,
        allowYellowCard: false 
      };
    }

    const s2Risk = votes.find(v => v.securityScore === 'S2');
    if (s2Risk) {
      if (highUrgency) {
        return { 
          decision: 'YELLOW-CARD', 
          reason: `High Security Risk (S2) detected, but U1 Urgency allows conditional approval.`,
          allowYellowCard: true,
          debtAction: s2Risk.comment
        };
      } else {
        return { 
          decision: 'NO-GO', 
          reason: `High Security Risk (S2) and insufficient urgency for bypass.`,
          allowYellowCard: false 
        };
      }
    }

    return { decision: 'GO', reason: 'All evaluations within acceptable limits.', allowYellowCard: false };
  }
};

module.exports = aceCore;
