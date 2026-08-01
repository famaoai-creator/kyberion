/**
 * Docs-honesty contract (QM-10, ported pattern from qm's security-docs tests):
 * the load-bearing claims our governance documents make must be provably true
 * against the code and config, so the docs cannot drift into flattery.
 */
import { describe, expect, it } from 'vitest';
import { composeSecurityPosture, pathResolver } from '@agent/core';
import { safeExistsSync, safeLstat, safeReadFile } from '@agent/core/secure-io';

const root = pathResolver.rootDir();
const read = (relative: string): string =>
  String(safeReadFile(`${root}/${relative}`, { encoding: 'utf8' }));

describe('docs-honesty contract (QM-10)', () => {
  describe('AGENTS.md invariants are enforced, not aspirational', () => {
    it('secure-io is a lint-enforced boundary, not a convention', () => {
      const eslintConfig = read('eslint.config.js');
      expect(eslintConfig).toContain("name: 'node:fs'");
      expect(eslintConfig).toContain('secure-io');
    });

    it('CLAUDE.md / CODEX.md / GEMINI.md are symlinks to the canonical AGENTS.md', () => {
      for (const alias of ['CLAUDE.md', 'CODEX.md', 'GEMINI.md']) {
        expect(safeLstat(`${root}/${alias}`).isSymbolicLink(), `${alias} must be a symlink`).toBe(
          true
        );
      }
    });

    it('the plugin loader really skips unapproved plugins (fail-closed execution)', () => {
      // Assert on the enforcement code itself, not on comments describing it —
      // deleting the gate while keeping its comment must fail this test.
      const loader = read('libs/core/skill-plugin-loader.ts');
      expect(loader).toContain('skipping rather than executing an unapproved plugin');
      expect(loader).toContain('activationStatus');
      const installer = read('libs/core/plugin-managed-install.ts');
      expect(installer).toContain('pending_approval');
    });

    it('the three data tiers the docs describe exist in tier-guard', () => {
      const tierGuard = read('libs/core/tier-guard.ts');
      for (const tier of ['personal', 'confidential', 'public']) {
        expect(tierGuard).toContain(`'${tier}'`);
      }
    });
  });

  describe('PACKAGING_CONTRACT clause table is honest', () => {
    it('every ENFORCED clause names a verifier that actually exists', () => {
      const contract = read('docs/PACKAGING_CONTRACT.md');
      const packageJson = JSON.parse(read('package.json')) as {
        scripts: Record<string, string>;
      };
      const enforcedRows = contract
        .split('\n')
        .filter((line) => line.includes('**ENFORCED**') && line.trim().startsWith('|'));
      expect(enforcedRows.length).toBeGreaterThan(0);
      for (const row of enforcedRows) {
        const verifierCell = row.split('|').at(-2)?.trim() ?? '';
        const scriptRef = /pnpm run ([a-z:-]+)/.exec(verifierCell)?.[1];
        const fileRef = /`([^`]+\.test\.ts)`/.exec(verifierCell)?.[1];
        expect(
          scriptRef || fileRef,
          `ENFORCED row must name a verifier: ${row.trim()}`
        ).toBeTruthy();
        if (scriptRef) {
          expect(
            packageJson.scripts[scriptRef],
            `verifier script "${scriptRef}" must exist in package.json`
          ).toBeTruthy();
        }
        if (fileRef) {
          expect(safeExistsSync(`${root}/${fileRef}`), `verifier file ${fileRef} must exist`).toBe(
            true
          );
        }
      }
    });
  });

  describe('QM adoption plan §6 claims hold', () => {
    it('the posture floor is genuinely monotone (strict cannot be loosened)', () => {
      expect(composeSecurityPosture('strict', 'dangerous')).toBe('strict');
      expect(composeSecurityPosture('auto', 'dangerous')).toBe('auto');
    });

    it('the de-obfuscation module the plan describes exists with its guards', () => {
      const normalize = read('libs/core/shell-command-normalize.ts');
      expect(normalize).toContain('allowableCommands');
      expect(normalize).toContain('PRIVILEGE_WRAPPERS');
      expect(normalize).toContain('scannableCommand');
    });

    it('the memory notebook module is the single source the plan claims', () => {
      const notebook = read('libs/core/memory-notebook.ts');
      expect(notebook).toContain('neutralizeUntrustedProvenance');
      const actuator = read('libs/actuators/working-memory-actuator/src/index.ts');
      expect(actuator).toContain('neutralizeUntrustedProvenance');
      expect(actuator).not.toContain('function neutralizeUntrustedProvenance');
    });
  });
});
