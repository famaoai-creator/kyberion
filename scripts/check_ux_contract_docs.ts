import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';
import { loadSurfaceRoleCatalog } from '@agent/core/surface-role-catalog';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const UX_CONTRACT_DOCS = [
  'README.md',
  'docs/QUICKSTART.md',
  'docs/OPERATOR_UX_GUIDE.md',
] as const;

const INTERNAL_TERMS = /\b(?:mission|actuator|ADF|packet|ledger|capability bundle)\b/giu;
const EXTERNAL_TERMS = [/\brequest\b/iu, /\bplan\b/iu, /\bresult\b/iu, /\bnext action\b/iu];

function read(relativePath: string): string {
  return readTextFile(pathResolver.rootResolve(relativePath));
}

function frontDoor(markdown: string): string {
  const firstSection = markdown.indexOf('\n## ');
  return firstSection < 0 ? markdown : markdown.slice(0, firstSection);
}

export function checkUxContractDocs(): string[] {
  const failures: string[] = [];
  for (const relativePath of UX_CONTRACT_DOCS) {
    const content = read(relativePath);
    const door = frontDoor(content);
    const internal = door.match(INTERNAL_TERMS) || [];
    if (internal.length > 0) {
      failures.push(
        `${relativePath}: internal terms in the front door: ${[...new Set(internal)].join(', ')}`
      );
    }
    for (const term of EXTERNAL_TERMS) {
      if (!term.test(door)) failures.push(`${relativePath}: missing plain-language term ${term}`);
    }
  }
  const roles = loadSurfaceRoleCatalog();
  for (const role of roles.roles) {
    if (!role.enabled) continue;
    if (!role.tagline_key) {
      failures.push(`${role.id}: enabled surface is missing tagline_key`);
      continue;
    }
    if (!resolveVocabularyEntry(role.tagline_key)) {
      failures.push(
        `${role.id}: tagline_key is missing from the vocabulary catalog: ${role.tagline_key}`
      );
    }
  }
  return failures;
}

export const runCheckUxContractDocs = defineScript({
  name: 'check:ux-contract-docs',
  flags: [],
  run(context) {
    const failures = checkUxContractDocs();
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    context.print(
      `[check:ux-contract-docs] OK (${UX_CONTRACT_DOCS.length} documents and surface taglines)`
    );
    return { failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_ux_contract_docs.ts') ||
  isDirectScript(import.meta.url, 'check_ux_contract_docs.js')
)
  void runCheckUxContractDocs();
