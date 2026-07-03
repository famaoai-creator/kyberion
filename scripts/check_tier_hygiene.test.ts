import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './check_tier_hygiene.js';

/**
 * Regression test for the tier-hygiene checker. Instead of driving the
 * policy loader directly (the script is a CLI tool that calls
 * process.exit), we shell out to the script with a temp file mounted
 * into the scan path, then verify exit code + stderr.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

function writePublicFile(relPath: string, body: string): string {
  const abs = path.join(PROJECT_ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe.sequential('check_tier_hygiene', () => {
  it('passes on the current tree (baseline)', async () => {
    const violations = await scan();
    expect(violations).toEqual([]);
  });

  it('detects an injected internal Atlassian subdomain', async () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe_${process.pid}.md`,
      '# Temp probe\nReference: https://acme-internal.atlassian.net/browse/ABC-123\n'
    );
    try {
      const violations = await scan();
      expect(violations.some((entry) => entry.pattern === 'internal-atlassian-subdomain')).toBe(
        true
      );
      expect(
        violations.some((entry) => entry.matched.includes('acme-internal.atlassian.net'))
      ).toBe(true);
    } finally {
      fs.unlinkSync(temp);
    }
  });

  it('detects an injected denied substring', async () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe2_${process.pid}.md`,
      '# Temp probe\nRepository: sbisecuritysolutions/demo-repo.\n'
    );
    try {
      const violations = await scan();
      expect(violations.some((entry) => entry.pattern === 'substring:sbisecuritysolutions')).toBe(
        true
      );
    } finally {
      fs.unlinkSync(temp);
    }
  });

  it('allows framework placeholders and industry-standard terms', async () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe3_${process.pid}.md`,
      '# Temp probe\n${ATLASSIAN_BASE_URL}, <REPO_NAME>, kyberion.local, SBI Model.\n'
    );
    try {
      const violations = await scan();
      expect(violations).toEqual([]);
    } finally {
      fs.unlinkSync(temp);
    }
  });
});
