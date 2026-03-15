import { createHash } from 'node:crypto';
import { safeAppendFileSync, safeExistsSync, safeReadFile } from './secure-io.js';

/**
 * ACE (Autonomous Consensus Engine) Core Utility
 */
export const aceCore = {
  calculateHash: (text: string) => {
    return createHash('sha256').update(text).digest('hex');
  },

  appendThought: (minutesPath: string, role: string, thought: string, _metadata = {}) => {
    let content = '';
    if (safeExistsSync(minutesPath)) {
      content = safeReadFile(minutesPath, { encoding: 'utf8' }) as string;
    }

    const prevHash = aceCore.calculateHash(content);
    const timestamp = new Date().toISOString();

    const entryHeader = `\n### [${role}] @${timestamp} | PREV_HASH: ${prevHash.substring(0, 8)} | HASH: `;
    const entryBody = `\n> ${thought}\n`;

    const entryHash = aceCore.calculateHash(entryHeader + entryBody);
    const finalEntry = entryHeader + entryHash.substring(0, 8) + entryBody;

    safeAppendFileSync(minutesPath, finalEntry);
    return entryHash;
  },

  validateIntegrity: (minutesPath: string) => {
    if (!safeExistsSync(minutesPath)) return true;
    const content = safeReadFile(minutesPath, { encoding: 'utf8' }) as string;
    const entries = content.split(/\n(?=### \[)/).filter(Boolean);
    let prefixContent = '';

    for (const entry of entries) {
      const headerMatch = entry.match(/^### \[(.+?)\] @(.+?) \| PREV_HASH: ([a-f0-9]{8}) \| HASH: ([a-f0-9]{8})\n/s);
      if (!headerMatch) return false;

      const [, role, timestamp, prevHash, storedHash] = headerMatch;
      const body = entry.slice(headerMatch[0].length);
      const expectedPrevHash = aceCore.calculateHash(prefixContent).substring(0, 8);
      if (prevHash !== expectedPrevHash) return false;

      const headerPrefix = `\n### [${role}] @${timestamp} | PREV_HASH: ${prevHash} | HASH: `;
      const computedHash = aceCore.calculateHash(headerPrefix + body).substring(0, 8);
      if (storedHash !== computedHash) return false;

      prefixContent += headerPrefix + storedHash + body;
    }

    return true;
  },

  evaluateDecision: (votes: any[]) => {
    const securityRisk = votes.find((v) => v.securityScore === 'S1');
    const highUrgency = votes.some((v) => v.urgencyScore === 'U1');

    if (securityRisk) {
      return {
        decision: 'NO-GO',
        reason: `Critical Security Risk (S1) detected by ${securityRisk.role}.`,
        allowYellowCard: false,
      };
    }

    const s2Risk = votes.find((v) => v.securityScore === 'S2');
    if (s2Risk) {
      if (highUrgency) {
        return {
          decision: 'YELLOW-CARD',
          reason: `High Security Risk (S2) detected, but U1 Urgency allows conditional approval.`,
          allowYellowCard: true,
          debtAction: s2Risk.comment,
        };
      } else {
        return {
          decision: 'NO-GO',
          reason: `High Security Risk (S2) and insufficient urgency for bypass.`,
          allowYellowCard: false,
        };
      }
    }

    return {
      decision: 'GO',
      reason: 'All evaluations within acceptable limits.',
      allowYellowCard: false,
    };
  },
};
