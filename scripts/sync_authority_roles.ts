import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import { loadAuthorityRoleIndex as loadGovernedAuthorityRoleIndex } from '@agent/core/mission/mission-team-index';
import {
  loadAuthorityRoleCards,
  projectAuthorityRolePermissions,
  type AuthorityRoleCard,
} from '@agent/core/organization/authority-role-registry';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

/**
 * The Authority Role registry (concept model v2 D6) is the card directory
 * `knowledge/product/governance/authority-roles/`. This generator projects it
 * into its two generated views and `--check` is their drift gate:
 * - `authority-role-index.json` — the assignable role catalog (cards without
 *   `assignable: false`, registry-only fields removed);
 * - security-policy.json `authority_role_permissions` — every card's
 *   `permissions`, verbatim. The rest of security-policy.json is untouched.
 */
const DIRECTORY = pathResolver.knowledge('product/governance/authority-roles');
const SNAPSHOT = pathResolver.knowledge('product/governance/authority-role-index.json');
const SECURITY_POLICY = pathResolver.knowledge('product/governance/security-policy.json');

function loadCards(): Record<string, AuthorityRoleCard> {
  const cards = loadAuthorityRoleCards();
  if (!cards) {
    throw new Error(
      '[AUTHORITY_ROLE_REGISTRY_MISSING] knowledge/product/governance/authority-roles/ is missing or empty | restore the card directory; it is the only authority role registry'
    );
  }
  return cards;
}

async function formatJson(value: unknown, prettierConfig: Record<string, unknown>) {
  return prettierFormat(JSON.stringify(value, null, 2), { ...prettierConfig, parser: 'json' });
}

async function renderCards(
  cards: Record<string, AuthorityRoleCard>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile[]> {
  return Promise.all(
    Object.entries(cards)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([role, card]) => ({
        path: path.join(DIRECTORY, `${role}.json`),
        content: await formatJson({ ...card, role }, prettierConfig),
      }))
  );
}

async function renderSnapshot(prettierConfig: Record<string, unknown>): Promise<GeneratedFile> {
  const roles = loadGovernedAuthorityRoleIndex();
  const authority_roles: Record<string, unknown> = {};
  for (const [role, record] of Object.entries(roles).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    authority_roles[role] = record;
  }

  return {
    path: SNAPSHOT,
    content: await formatJson(
      {
        $schema: '../schemas/authority-role-index.schema.json',
        version: '1.0.0',
        authority_roles,
      },
      prettierConfig
    ),
  };
}

async function renderSecurityPolicy(
  cards: Record<string, AuthorityRoleCard>,
  prettierConfig: Record<string, unknown>
): Promise<GeneratedFile> {
  const policy = parseSafeJsonObjectInput(
    String(safeReadFile(SECURITY_POLICY, { encoding: 'utf8' })),
    'security-policy.json'
  );
  const current = policy.authority_role_permissions;
  const existingOrder =
    current && typeof current === 'object' && !Array.isArray(current) ? Object.keys(current) : [];
  policy.authority_role_permissions = projectAuthorityRolePermissions(cards, existingOrder);
  return { path: SECURITY_POLICY, content: await formatJson(policy, prettierConfig) };
}

async function render(): Promise<GeneratedFile[]> {
  const cards = loadCards();
  const prettierConfig = (await resolvePrettierConfig(SNAPSHOT)) ?? {};
  return [
    ...(await renderCards(cards, prettierConfig)),
    await renderSnapshot(prettierConfig),
    await renderSecurityPolicy(cards, prettierConfig),
  ];
}

export const runSyncAuthorityRoles = defineGenerator({
  id: 'authority-roles',
  outputs: (_context, files) => files.map((file) => file.path),
  normalize: (content) =>
    JSON.stringify(parseSafeJsonObjectInput(content, 'authority-role generated output')),
  render,
});

if (
  isDirectScript(import.meta.url, 'sync_authority_roles.ts') ||
  isDirectScript(import.meta.url, 'sync_authority_roles.js')
)
  void runSyncAuthorityRoles();
