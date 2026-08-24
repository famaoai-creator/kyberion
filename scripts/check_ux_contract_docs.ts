import { pathResolver, safeReadFile } from '@agent/core';

export const UX_CONTRACT_DOCS = [
  'README.md',
  'docs/QUICKSTART.md',
  'docs/OPERATOR_UX_GUIDE.md',
] as const;

const INTERNAL_TERMS = /\b(?:mission|actuator|ADF|packet|ledger|capability bundle)\b/giu;
const EXTERNAL_TERMS = [/\brequest\b/iu, /\bplan\b/iu, /\bresult\b/iu, /\bnext action\b/iu];

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
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
  return failures;
}

export function main(): void {
  const failures = checkUxContractDocs();
  if (failures.length > 0) {
    console.error('[check:ux-contract-docs] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[check:ux-contract-docs] OK (${UX_CONTRACT_DOCS.length} documents)`);
}

if (process.argv[1]?.endsWith('check_ux_contract_docs.ts')) main();
