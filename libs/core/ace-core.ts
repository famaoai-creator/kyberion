import { createHash } from 'node:crypto';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from './secure-io.js';
import { nowIso } from './foundation/time.js';

function safeMinutesPath(minutesPath: string): string {
  const safePath = assertSafeRepositoryPath(minutesPath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`[ACE_MINUTES] minutes path must be a regular file: ${minutesPath}`);
  }
  return safePath;
}

/**
 * ACE (Autonomous Consensus Engine) Core Utility
 */
export interface AceVote {
  securityScore?: string;
  urgencyScore?: string;
  role?: string;
  comment?: string;
}

export const aceCore = {
  calculateHash: (text: string) => {
    return createHash('sha256').update(text).digest('hex');
  },

  appendThought: (minutesPath: string, role: string, thought: string, _metadata = {}) => {
    const safePath = safeMinutesPath(minutesPath);
    let content = '';
    if (safeExistsSync(safePath)) {
      content = safeReadFile(safePath, { encoding: 'utf8' }) as string;
    }

    const prevHash = aceCore.calculateHash(content);
    const timestamp = nowIso();

    const entryHeader = `\n### [${role}] @${timestamp} | PREV_HASH: ${prevHash.substring(0, 8)} | HASH: `;
    const entryBody = `\n> ${thought}\n`;

    const entryHash = aceCore.calculateHash(entryHeader + entryBody);
    const finalEntry = entryHeader + entryHash.substring(0, 8) + entryBody;

    safeAppendFileSync(safePath, finalEntry);
    return entryHash;
  },

  validateIntegrity: (minutesPath: string) => {
    const safePath = safeMinutesPath(minutesPath);
    if (!safeExistsSync(safePath)) return true;
    const content = safeReadFile(safePath, { encoding: 'utf8' }) as string;
    const entries = content.split(/\n(?=### \[)/).filter(Boolean);
    let prefixContent = '';

    for (const entry of entries) {
      const headerMatch = entry.match(
        /^### \[(.+?)\] @(.+?) \| PREV_HASH: ([a-f0-9]{8}) \| HASH: ([a-f0-9]{8})\n/s
      );
      if (!headerMatch) return false;

      const [, role, timestamp, prevHash, storedHash] = headerMatch;
      // The header matcher consumes the newline separating the hash field from
      // the thought body; restore it so verification hashes the same bytes as
      // appendThought().
      const body = `\n${entry.slice(headerMatch[0].length)}`;
      const expectedPrevHash = aceCore.calculateHash(prefixContent).substring(0, 8);
      if (prevHash !== expectedPrevHash) return false;

      const headerPrefix = `\n### [${role}] @${timestamp} | PREV_HASH: ${prevHash} | HASH: `;
      const computedHash = aceCore.calculateHash(headerPrefix + body).substring(0, 8);
      if (storedHash !== computedHash) return false;

      prefixContent += headerPrefix + storedHash + body;
    }

    return true;
  },

  evaluateDecision: (votes: AceVote[]) => {
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
