import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression test for the tier-hygiene checker. Instead of driving the
 * policy loader directly (the script is a CLI tool that calls
 * process.exit), we shell out to the script with a temp file mounted
 * into the scan path, then verify exit code + stderr.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, 'check_tier_hygiene.ts');
const PROJECT_ROOT = path.resolve(HERE, '..');

function writePublicFile(relPath: string, body: string): string {
  const abs = path.join(PROJECT_ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function runChecker(): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('pnpm', ['tsx', SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe('check_tier_hygiene', () => {
  it('passes on the current tree (baseline)', () => {
    const result = runChecker();
    expect(result.code).toBe(0);
  });

  it('detects an injected internal Atlassian subdomain', () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe_${process.pid}.md`,
      '# Temp probe\nReference: https://acme-internal.atlassian.net/browse/ABC-123\n',
    );
    try {
      const result = runChecker();
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/internal-atlassian-subdomain/u);
      expect(result.stderr).toMatch(/acme-internal\.atlassian\.net/u);
    } finally {
      fs.unlinkSync(temp);
    }
  });

  it('detects an injected denied substring', () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe2_${process.pid}.md`,
      '# Temp probe\nRepository: example_org/demo-repo.\n',
    );
    try {
      const result = runChecker();
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/substring:example_org/u);
    } finally {
      fs.unlinkSync(temp);
    }
  });

  it('allows framework placeholders and industry-standard terms', () => {
    const temp = writePublicFile(
      `knowledge/public/__tier_hygiene_probe3_${process.pid}.md`,
      '# Temp probe\n${ATLASSIAN_BASE_URL}, <REPO_NAME>, kyberion.local, SBI Model.\n',
    );
    try {
      const result = runChecker();
      expect(result.code).toBe(0);
    } finally {
      fs.unlinkSync(temp);
    }
  });
});
