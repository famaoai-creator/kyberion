/** Metadata-only identity readiness; installation state is never copied to a worktree. */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { safeExecResult, safeExistsSync } from '@agent/core/secure-io';
import { resolveScopeContext } from '@agent/core/scope-context';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import { currentExecutionScope, parseSafeJsonInput } from '@agent/core/foundation';
import { currentResourceAccessScope } from '@agent/core/foundation/resource-access-scope';
import { getPluginExecutionContext } from '@agent/core/shell/sandbox-policy';
import { isVitestProcess, getRegisteredEnvText } from '@agent/core/foundation/env';
import { resolveInstallationGovernanceRoot } from '@agent/core/vcs/governance-host';
import { hasDelegatedExecutionContext } from '@agent/core/governance/delegated-execution';
import { hasHumanExecutionContext } from '@agent/core/governance/human-execution';
import { hasExternalOperationAuthority } from '@agent/core/governance/external-operation';
import { shellQuoteArg } from '@agent/core/organization/tenant-governance';

export interface InstalledIdentityReadiness {
  ready: boolean;
  governance_root: string;
  source: 'local' | 'installation' | 'unavailable';
  next?: string;
}
const prefix = 'KYBERION_IDENTITY_READINESS:';
export const IDENTITY_READINESS_CHILD = `
const input = JSON.parse(await new Promise(resolve => {
  let raw = ''; process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', () => resolve(raw));
}));
const { pathResolver } = await import(input.coreUrl + 'path-resolver.js');
const { resolvePromotionTargetRoot } = await import(input.coreUrl + 'knowledge/memory-promotion-git.js');
const { withScopeEnvOnly, resolveScopeContext } = await import(input.coreUrl + 'scope-context.js');
const { resolveActiveProfileRoot } = await import(input.coreUrl + 'profile-root.js');
const { safeExistsSync } = await import(input.coreUrl + 'secure-io.js');
const path = await import('node:path');
if (pathResolver.rootDir() !== input.root) throw new Error('Installation root mismatch');
resolvePromotionTargetRoot(input.sourceRoot);
const ready = withScopeEnvOnly(() => {
  if (JSON.stringify(resolveScopeContext()) !== JSON.stringify(input.scope)) throw new Error('Identity scope mismatch');
  return safeExistsSync(path.join(resolveActiveProfileRoot(), 'my-identity.json'));
}, input.scope);
process.stdout.write('\\n${prefix}' + JSON.stringify({ ready }) + '\\n');
`;

export function inspectInstalledIdentity(): InstalledIdentityReadiness {
  const currentRoot = pathResolver.rootDir();
  const local = (): InstalledIdentityReadiness => ({
    ready: safeExistsSync(path.join(resolveActiveProfileRoot(), 'my-identity.json')),
    governance_root: currentRoot,
    source: 'local',
  });
  // Scoped worker/plugin callers must keep the authority of their own process.
  if (
    isVitestProcess() ||
    getRegisteredEnvText('KYBERION_SUDO') ||
    getRegisteredEnvText('KYBERION_SUDO_SCOPE') ||
    currentScopeEnvelope() ||
    hasDelegatedExecutionContext() ||
    hasHumanExecutionContext() ||
    hasExternalOperationAuthority() ||
    currentExecutionScope() ||
    currentResourceAccessScope() ||
    getPluginExecutionContext()
  ) {
    try {
      const readiness = local();
      if (readiness.ready) return readiness;
    } catch {
      // Denied local metadata and an absent worktree profile cannot prove installation absence.
    }
    return {
      ready: false,
      governance_root: currentRoot,
      source: 'unavailable',
      next: 'Installation identity readiness cannot be established in this scoped execution. Run baseline-check from the installed checkout in a standalone operator session with the same explicit tenant and customer stance.',
    };
  }
  let root = currentRoot;
  try {
    root = resolveInstallationGovernanceRoot(currentRoot);
    if (path.resolve(root) === path.resolve(currentRoot)) return local();
    const scope = resolveScopeContext();
    const result = safeExecResult(
      process.execPath,
      ['--input-type=module', '-e', IDENTITY_READINESS_CHILD],
      {
        cwd: root,
        timeoutMs: 15_000,
        maxOutputMB: 1,
        env: {
          KYBERION_ROOT: root,
          KYBERION_TIER: scope.tier,
          KYBERION_TENANT: scope.tenant_slug ?? '',
          KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
          KYBERION_PROJECT_ID: scope.project_id ?? '',
          KYBERION_TASK_ID: scope.task_id ?? '',
          MISSION_ID: scope.mission_id ?? '',
          KYBERION_NHI_ACTOR: scope.nhi_id ?? '',
          KYBERION_CUSTOMER: scope.customer_stance ?? '',
          KYBERION_VIEWER_PRINCIPAL: scope.viewer_principal ?? '',
          SYSTEM_ROLE: getRegisteredEnvText('SYSTEM_ROLE'),
        },
        input: JSON.stringify({
          root,
          sourceRoot: currentRoot,
          scope,
          coreUrl: `${pathToFileURL(pathResolver.rootResolve('libs/core/dist')).href}/`,
        }),
      }
    );
    const line = result.stdout
      .split('\n')
      .filter((value) => value.startsWith(prefix))
      .at(-1);
    if (result.status !== 0 || !line) throw new Error('Identity probe unavailable');
    const response = parseSafeJsonInput(
      line.slice(prefix.length),
      'Installed identity readiness'
    ) as { ready?: unknown };
    if (typeof response.ready !== 'boolean') throw new Error('Invalid identity readiness response');
    return {
      ready: response.ready,
      governance_root: root,
      source: 'installation',
      ...(!response.ready
        ? {
            next: `Complete reviewed identity onboarding in the installed repository at ${root}, with the same explicit tenant and customer stance.`,
          }
        : {}),
    };
  } catch {
    return {
      ready: false,
      governance_root: root,
      source: 'unavailable',
      next: `Run baseline-check in the installed repository at ${root}; verify its built runtime and access before onboarding again.`,
    };
  }
}

export function canonicalAuthorityCommand(root: string, argv: string[]): string {
  const quote = shellQuoteArg;
  const args = argv.map((value, index) => {
    if (index > 0 && ['--file', '--out'].includes(argv[index - 1]))
      return path.resolve(pathResolver.rootDir(), value);
    const option = ['--file=', '--out='].find((prefix) => value.startsWith(prefix));
    return option
      ? option + path.resolve(pathResolver.rootDir(), value.slice(option.length))
      : value;
  });
  const scope = resolveScopeContext();
  const env = {
    KYBERION_TIER: scope.tier,
    KYBERION_TENANT: scope.tenant_slug ?? '',
    KYBERION_CUSTOMER: scope.customer_stance ?? '',
    KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
    KYBERION_PROJECT_ID: scope.project_id ?? '',
    KYBERION_TASK_ID: scope.task_id ?? '',
    MISSION_ID: scope.mission_id ?? '',
    KYBERION_NHI_ACTOR: scope.nhi_id ?? '',
    KYBERION_VIEWER_PRINCIPAL: scope.viewer_principal ?? '',
  };
  return `cd ${quote(root)} && ${Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(' ')} pnpm onboarding authority ${args.map(quote).join(' ')}`;
}
