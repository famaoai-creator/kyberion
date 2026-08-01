/**
 * check:packaging-contract — machine verification of the ENFORCED clauses in
 * docs/PACKAGING_CONTRACT.md §Distribution contract (QM-08).
 *
 * Pattern from qm's deployment-directory contract: every clause declares an
 * honest status (ENFORCED / VALIDATED-ONLY / RESERVED) and every ENFORCED
 * clause names the verifier that proves it. This script is that verifier for
 * the distribution clauses:
 *
 *  - image.tier-isolation: .dockerignore excludes every data-tier path that
 *    must never be baked into an image.
 *  - config.no-secret-values: env.example documents names, never values —
 *    no uncommented assignment carries a secret-shaped value, and no line
 *    (commented or not) contains a high-confidence credential pattern.
 */

import { pathResolver } from '@agent/core';
import { safeReadFile } from '@agent/core/secure-io';

interface ClauseFailure {
  clause: string;
  detail: string;
}

const failures: ClauseFailure[] = [];

function checkImageTierIsolation(): void {
  const required = [
    'knowledge/personal/',
    'knowledge/confidential/',
    'customer/',
    'work/',
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
  ];
  const raw = String(safeReadFile(`${pathResolver.rootDir()}/.dockerignore`, { encoding: 'utf8' }));
  const lines = new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
  const protectedRoots = ['knowledge/', 'customer/', 'work/', '.env', '*.pem', '*.key'];
  for (const line of lines) {
    if (!line.startsWith('!')) continue;
    const negated = line.slice(1);
    if (
      protectedRoots.some(
        (root) => negated.startsWith(root.replace('*', '')) || negated.includes(root)
      )
    ) {
      failures.push({
        clause: 'image.tier-isolation',
        detail: `.dockerignore negation "${line}" re-includes a protected data-tier path — dockerignore is last-match-wins, so this silently defeats the exclusion.`,
      });
    }
  }
  for (const entry of required) {
    if (!lines.has(entry)) {
      failures.push({
        clause: 'image.tier-isolation',
        detail: `.dockerignore is missing the required exclusion "${entry}" — confidential/personal/customer data must never be baked into an image (OP-03).`,
      });
    }
  }
}

const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[bapos]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
];

const SECRET_NAME_HINT = /(TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL)/;
const PLACEHOLDER_VALUE =
  /^(?:|["']{2}|<[^>]*>|\$\{[^}]*\}|your[-_].*|changeme.*|placeholder.*|xxx+|\.\.\.|0|1|true|false|none|dummy.*|example.*|redacted)$/i;

function checkNoSecretValues(): void {
  const raw = String(
    safeReadFile(`${pathResolver.rootDir()}/docs/developer/env.example`, { encoding: 'utf8' })
  );
  raw.split('\n').forEach((line, index) => {
    const location = `docs/developer/env.example:${index + 1}`;
    for (const { name, pattern } of HIGH_CONFIDENCE_SECRET_PATTERNS) {
      if (pattern.test(line)) {
        failures.push({
          clause: 'config.no-secret-values',
          detail: `${location} contains a ${name}-shaped value; env.example documents names and descriptions, never values.`,
        });
      }
    }
    const trimmed = line.trim().replace(/^#\s*/, '');
    if (!trimmed) return;
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!assignment) return;
    const [, key, valueRaw] = assignment;
    const value = valueRaw!.trim().replace(/^["']|["']$/g, '');
    if (!SECRET_NAME_HINT.test(key!)) return;
    if (PLACEHOLDER_VALUE.test(value) || value.length <= 8) return;
    failures.push({
      clause: 'config.no-secret-values',
      detail: `${location} assigns a non-placeholder value to secret-shaped key ${key}; use an empty value or a <placeholder>.`,
    });
  });
}

checkImageTierIsolation();
checkNoSecretValues();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[check:packaging-contract] ${failure.clause}: ${failure.detail}`);
  }
  console.error(
    `[check:packaging-contract] FAILED — ${failures.length} clause violation(s). See docs/PACKAGING_CONTRACT.md §Distribution contract.`
  );
  process.exit(1);
}
console.log('[check:packaging-contract] OK');
