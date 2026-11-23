#!/usr/bin/env node
import * as path from 'node:path';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation/json';
import { currentExecutionScope } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/authority';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import {
  STANCE_ENV_VAR,
  STANCE_SCOPE_BOUND_ENV_VAR,
  parseStanceSelection,
  resolveStance,
  stanceDirForSlug,
  type ResolvedStance,
} from '@agent/core/stance-resolver';
import { listTenantProfileSlugs, readTenantProfile } from '@agent/core/tenant-registry';
import {
  loadOrganizationProfileAtPath,
  resolveTenantOrganizationProfilePath,
} from '@agent/core/organization-profile';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

type Print = (value: unknown) => void;

/** Activation profile the operator sources to select the stance in a shell. */
export const STANCE_ENV_PATH = pathResolver.shared('runtime/stance.env');
/** Files a stance needs before it can be selected. */
export const STANCE_REQUIRED_FILES = ['stance.json', 'identity.json'];

/**
 * Tenants the operator may act for: the active profiles in the durable tenant
 * registry (`knowledge/personal/tenants/`). Server-side authority, never the
 * stance's own declaration.
 */
export function permittedStanceTenants(): string[] {
  return listTenantProfileSlugs().filter((slug) => readTenantProfile(slug)?.status === 'active');
}

export interface SwitchedStance {
  slug: string;
  envPath: string;
  /** The acting-for selection, when `stance.json` declares `acting_for`. */
  stance?: ResolvedStance;
}

export function switchStance(
  slugInput: string,
  options: { permittedTenants?: () => readonly string[] } = {}
): SwitchedStance {
  const slug = slugInput.trim();
  const rootDir = pathResolver.rootDir();
  const stanceDir = stanceDirForSlug(slug, rootDir);
  if (!safeExistsSync(stanceDir) || !safeLstat(stanceDir).isDirectory()) {
    throw new Error(
      `Stance not found: ${path.relative(rootDir, stanceDir)}. Run pnpm stance:create first.`
    );
  }

  const missing = STANCE_REQUIRED_FILES.filter((required) => {
    const requiredPath = assertSafeRepositoryPath(path.join(stanceDir, required), {
      allowMissingLeaf: true,
      rootDir,
    });
    return !safeExistsSync(requiredPath) || !safeLstat(requiredPath).isFile();
  });
  if (missing.length > 0) {
    throw new Error(
      `Stance is not ready: ${path.relative(rootDir, stanceDir)} is missing ${missing.join(', ')}. Run pnpm stance:list to inspect readiness.`
    );
  }

  const stanceJsonPath = assertSafeRepositoryPath(path.join(stanceDir, 'stance.json'), {
    rootDir,
  });
  const selection = parseStanceSelection(readJson<unknown>(stanceJsonPath));
  // Selecting a tenant the operator may not serve is rejected before anything is written.
  const stance = selection
    ? resolveStance({
        permittedTenants: (options.permittedTenants ?? permittedStanceTenants)(),
        selection,
      })
    : undefined;

  const selected = stance?.selected;
  const executionScope = currentExecutionScope();
  const inheritedScope = currentScopeEnvelope()?.identity;
  if (
    (executionScope?.tenantBound && executionScope.tenantSlug !== selected?.tenantSlug) ||
    (inheritedScope && inheritedScope.tenant_slug !== selected?.tenantSlug) ||
    (executionScope?.organizationId &&
      executionScope.organizationId !== selected?.organizationId) ||
    (inheritedScope?.organization_id && inheritedScope.organization_id !== selected?.organizationId)
  ) {
    throw new Error(
      '[STANCE_NOT_PERMITTED] Selection conflicts with the governed execution scope.'
    );
  }
  const organizationId = selected?.organizationId;
  if (selected && organizationId) {
    const organizationMatches = withExecutionContext(
      'sovereign_concierge',
      () => {
        const profile = resolveTenantOrganizationProfilePath(
          selected.tenantSlug,
          organizationId,
          rootDir
        );
        return Boolean(
          profile && loadOrganizationProfileAtPath(profile.path).organization_id === organizationId
        );
      },
      undefined,
      selected.tenantSlug,
      organizationId
    );
    if (!organizationMatches) {
      throw new Error(
        '[STANCE_NOT_PERMITTED] Organization is not registered under the selected tenant.'
      );
    }
  }
  const lines = [
    `export ${STANCE_ENV_VAR}=${slug}`,
    `export ${STANCE_SCOPE_BOUND_ENV_VAR}=1`,
    'unset KYBERION_TIER KYBERION_PROJECT_ID MISSION_ID KYBERION_TASK_ID KYBERION_NHI_SESSION',
    // An explicitly empty canonical claim also masks a legacy NHI actor claim.
    "export KYBERION_NHI_ID=''",
    selected ? `export KYBERION_TENANT=${selected.tenantSlug}` : 'unset KYBERION_TENANT',
    selected?.organizationId
      ? `export KYBERION_ORGANIZATION_ID=${selected.organizationId}`
      : 'unset KYBERION_ORGANIZATION_ID',
  ];
  safeMkdir(path.dirname(STANCE_ENV_PATH), { recursive: true });
  safeWriteFile(STANCE_ENV_PATH, `${lines.join('\n')}\n`, { encoding: 'utf8' });
  return { slug, envPath: STANCE_ENV_PATH, ...(stance ? { stance } : {}) };
}

export function formatSwitchedStance(result: SwitchedStance): string[] {
  const selected = result.stance?.selected;
  return [
    `Switched stance to ${result.slug}`,
    ...(selected
      ? [
          `Acting for tenant ${selected.tenantSlug}` +
            (selected.organizationId ? `, organization ${selected.organizationId}` : '') +
            (selected.orgRole ? `, as ${selected.orgRole}` : ''),
        ]
      : []),
    `Activation profile: ${path.relative(pathResolver.rootDir(), result.envPath)}`,
    `Source it with: source ${path.relative(pathResolver.rootDir(), result.envPath)}`,
  ];
}

export function main(argv: string[], print: Print = () => undefined): string[] {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: stance_switch <slug>';
    if (slug) {
      print(usage);
      throw new ScriptExitError(0, '', true);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const result = switchStance(slug);
    return formatSwitchedStance(result);
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'stance_switch.ts') ||
  isDirectScript(import.meta.url, 'stance_switch.js')
)
  void defineScript({
    name: 'stance:switch',
    flags: [],
    run(context) {
      context.print(main(context.argv, context.print).join('\n'));
    },
  })();
