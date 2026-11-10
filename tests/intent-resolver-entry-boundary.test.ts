import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Intent resolver entry boundary (concept model v2 D7; R3 of the intent
 * resolver unification plan).
 *
 * Only the resolver entry reads utterance text. `resolveIntentResolutionPacket`
 * — the Stage-1 scorer — is used by exactly one production module,
 * `libs/core/intent/routing-decision.ts`. Surfaces, the front desk, discussion
 * outcomes, contract builders and evals call `resolveRoutingDecision`,
 * `resolveRoutingPacket` or `resolveOrganizationWorkRouting` there, and carry
 * the packet / RoutingDecision downstream instead of resolving again.
 *
 * The scan flags every production reference (call, import or value use) to the
 * scorer outside the entry. Its own definition, `typeof` type positions and
 * barrel re-exports are not references. Tests are exempt: they exercise the
 * scorer directly.
 */
const ENTRY = 'libs/core/intent/intent-resolver-entry.ts';
const DEFINITION = 'libs/core/intent/intent-resolution.ts';
const SCORER = 'resolveIntentResolutionPacket';

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function stripNonReferences(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, '')
    .replace(new RegExp(`typeof\\s+${SCORER}\\b`, 'g'), '')
    .replace(new RegExp(`function\\s+${SCORER}\\b`, 'g'), '');
}

describe('Intent resolver entry boundary', () => {
  it('confines resolveIntentResolutionPacket to the resolver entry', () => {
    const referencing = ['libs', 'scripts', 'presence', 'satellites']
      .flatMap((directory) => getAllFiles(path.join(rootDir, directory)))
      .filter((filePath) => /\.(ts|tsx|mts|cts|js|mjs)$/.test(filePath))
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => /^(libs|scripts|presence|satellites)\//.test(relPath))
      .filter((relPath) => !/(^|\/)(node_modules|dist|\.next)\//.test(relPath))
      .filter((relPath) => !/\.test\.[cm]?[jt]sx?$/.test(relPath))
      .filter((relPath) => relPath !== DEFINITION)
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        if (!content.includes(SCORER)) return false;
        return new RegExp(`(?<![\\w$])${SCORER}(?![\\w$])`).test(stripNonReferences(content));
      })
      .sort((a, b) => a.localeCompare(b));

    expect(
      referencing,
      `Only ${ENTRY} may use ${SCORER}. Resolve a request through the entry ` +
        '(resolveRoutingDecision / resolveRoutingPacket / resolveOrganizationWorkRouting) and ' +
        'carry its packet or RoutingDecision downstream instead of resolving the text again.'
    ).toEqual([ENTRY]);
  }, 60000);
});
