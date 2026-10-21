/** One installation trust store for standalone VCS hosts in related worktrees. */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '../path-resolver.js';
import {
  safeExecResult,
  safeReadFile,
  safeExistsSync,
  assertSafeRepositoryPath,
} from '../secure-io.js';
import { isVitestProcess, getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { resolvePromotionTargetRoot, type GitRunner } from '../knowledge/memory-promotion-git.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { hasExternalOperationAuthority } from '../governance/external-operation.js';
import { hasDelegatedExecutionContext } from '../governance/delegated-execution.js';
import { hasHumanExecutionContext } from '../governance/human-execution.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { storageFloorTier } from '../storage-layout.js';
import { sanitizeGhOutput, withPrPublicationBodySource, type PrBodySourceTier } from './github.js';
import { runVcsMutationWithApproval, type VcsHostMutation } from './publication-host.js';
import type { VcsCommandResult } from './git.js';

const git: GitRunner = (args, cwd) => safeExecResult('git', args, { cwd });
export function resolveInstallationGovernanceRoot(
  currentRoot: string,
  run: GitRunner = git
): string {
  const common = run(['rev-parse', '--path-format=absolute', '--git-common-dir'], currentRoot);
  if (common.status !== 0 || !common.stdout.trim())
    throw new Error('[PR_GOVERNANCE_ROOT] Cannot identify repository; check git worktree list');
  const commonDir = path.resolve(common.stdout.trim());
  if (path.basename(commonDir) !== '.git') return currentRoot;
  return resolvePromotionTargetRoot(path.dirname(commonDir), { currentRoot, gitRunner: run }).root;
}
export const resolvePrGovernanceRoot = resolveInstallationGovernanceRoot;

export function publicationBodySourceTier(bodyFile: string | undefined): PrBodySourceTier {
  if (!bodyFile) return 'inline';
  const relative = pathResolver.toRepoRelative(assertSafeRepositoryPath(bodyFile));
  return relative.startsWith('knowledge/public/') || storageFloorTier(relative) === 'public'
    ? 'public'
    : 'protected_or_unknown';
}

const RESULT_PREFIX = 'KYBERION_PR_GOVERNANCE_RESULT:';
/** Constant child program. No mutation or source bytes become shell text. */
export const PR_GOVERNANCE_CHILD = `
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const { pathResolver } = await import(input.coreUrl + 'path-resolver.js');
const { resolvePromotionTargetRoot } = await import(input.coreUrl + 'knowledge/memory-promotion-git.js');
const { withPrPublicationBodySource, sanitizeGhOutput } = await import(input.coreUrl + 'vcs/github.js');
const { withScopeEnvOnly, resolveScopeContext } = await import(input.coreUrl + 'scope-context.js');
const { runVcsMutationWithApproval } = await import(input.coreUrl + 'vcs/publication-host.js');
const lines = []; let response;
try {
  if (pathResolver.rootDir() !== input.governanceRoot) throw new Error('[PR_GOVERNANCE_ROOT] Child root mismatch');
  const target = resolvePromotionTargetRoot(input.mutation.params.cwd);
  if (target.root !== input.mutation.params.cwd) throw new Error('[PR_GOVERNANCE_ROOT] Worktree root mismatch');
  const result = withScopeEnvOnly(() => {
    if (JSON.stringify(resolveScopeContext()) !== JSON.stringify(input.sourceScope)) throw new Error('[PR_GOVERNANCE_SCOPE_MISMATCH] Child must preserve the worktree scope');
    return withPrPublicationBodySource(input.bodySourceTier, () => runVcsMutationWithApproval({
      ...input.mutation,
      params: { ...input.mutation.params, env: { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN } },
    }, input.invocationId, (line) => lines.push(String(line))));
  }, input.sourceScope);
  response = { ok: true, result, lines };
} catch (error) { response = { ok: false, error: sanitizeGhOutput(error instanceof Error ? error.message : String(error)), lines }; }
process.stdout.write('\\n${RESULT_PREFIX}' + JSON.stringify(response) + '\\n');
`;

export interface PrGovernanceTransport {
  (input: { root: string; payload: string; env: Record<string, string | undefined> }): {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
  };
}
const transport: PrGovernanceTransport = ({ root, payload, env }) =>
  safeExecResult(process.execPath, ['--input-type=module', '-e', PR_GOVERNANCE_CHILD], {
    cwd: root,
    env,
    input: payload,
    timeoutMs: 120_000,
    maxOutputMB: 2,
  });

export interface VcsGovernanceHostOptions {
  governanceRoot?: string;
  transport?: PrGovernanceTransport;
  gitRunner?: GitRunner;
  /** Trusted host provenance only; never populate from an action parameter. */
  bodySourceTier?: PrBodySourceTier;
}

export function runVcsMutationWithWorktreeGovernance(
  mutation: VcsHostMutation,
  invocationId: string,
  print: (value: unknown) => void,
  options: VcsGovernanceHostOptions = {}
): VcsCommandResult {
  const local = () =>
    options.bodySourceTier
      ? withPrPublicationBodySource(options.bodySourceTier, () =>
          runVcsMutationWithApproval(mutation, invocationId, print)
        )
      : runVcsMutationWithApproval(mutation, invocationId, print);
  if (
    currentScopeEnvelope() ||
    hasExternalOperationAuthority() ||
    hasDelegatedExecutionContext() ||
    hasHumanExecutionContext() ||
    currentExecutionScope() ||
    currentResourceAccessScope() ||
    getPluginExecutionContext() ||
    getRegisteredEnvText('KYBERION_SUDO') ||
    getRegisteredEnvText('KYBERION_SUDO_SCOPE')
  )
    return local();
  const currentRoot = pathResolver.rootDir();
  if (isVitestProcess() && !options.governanceRoot) return local();
  const governanceRoot = options.governanceRoot
    ? resolvePromotionTargetRoot(options.governanceRoot, { gitRunner: options.gitRunner }).root
    : resolveInstallationGovernanceRoot(currentRoot, options.gitRunner);
  if (path.resolve(governanceRoot) === path.resolve(currentRoot)) return local();
  if (!safeExistsSync(pathResolver.rootResolve('libs/core/dist/vcs/publication-host.js')))
    throw new Error('[PR_GOVERNANCE_ROOT] Built publication host missing; run pnpm build:packages');
  const bodySourceTier =
    options.bodySourceTier ??
    (mutation.operation === 'pr_create'
      ? publicationBodySourceTier(mutation.params.bodyFile)
      : 'protected_or_unknown');
  const frozen =
    mutation.operation === 'pr_create'
      ? {
          ...mutation,
          params: {
            ...mutation.params,
            body: mutation.params.bodyFile
              ? String(safeReadFile(mutation.params.bodyFile, { encoding: 'utf8' }))
              : (mutation.params.body ?? ''),
            bodyFile: undefined,
          },
        }
      : mutation;
  const { env: credentials, ...params } = frozen.params as typeof frozen.params & {
    env?: Record<string, string | undefined>;
  };
  const scope = resolveScopeContext();
  print(
    `[pr:publish] Approval and charter authority: ${governanceRoot} (shared by this repository's worktrees).`
  );
  const result = (options.transport ?? transport)({
    root: governanceRoot,
    env: {
      KYBERION_ROOT: governanceRoot,
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
      GH_TOKEN: credentials?.GH_TOKEN ?? getRegisteredEnvText('GH_TOKEN'),
      GITHUB_TOKEN: credentials?.GITHUB_TOKEN ?? getRegisteredEnvText('GITHUB_TOKEN'),
    },
    payload: JSON.stringify({
      governanceRoot,
      coreUrl: `${pathToFileURL(pathResolver.rootResolve('libs/core/dist')).href}/`,
      mutation: {
        operation: frozen.operation,
        params: { ...params, cwd: params.cwd ?? currentRoot },
      },
      invocationId,
      bodySourceTier,
      sourceScope: scope,
    }),
  });
  const line = result.stdout
    .split('\n')
    .filter((item) => item.startsWith(RESULT_PREFIX))
    .at(-1);
  if (result.status !== 0 || !line)
    throw new Error(
      `[PR_GOVERNANCE_UNAVAILABLE] ${sanitizeGhOutput(result.error?.message || result.stderr).slice(-1500)} | Verify prior publication before retrying.`
    );
  const response = parseSafeJsonInput(
    line.slice(RESULT_PREFIX.length),
    'VCS governance response'
  ) as {
    ok: boolean;
    result?: VcsCommandResult;
    error?: string;
    lines?: string[];
  };
  for (const message of response.lines ?? []) print(message);
  if (!response.ok || !response.result)
    throw new Error(response.error || '[PR_GOVERNANCE_UNAVAILABLE] No publication result');
  return response.result;
}

/** Compatibility entry point: readiness remains owned by the PR CLI. */
export function publishWithWorktreeGovernance(
  publication: Extract<VcsHostMutation, { operation: 'pr_create' }>['params'],
  invocationId: string,
  print: (value: unknown) => void,
  options: VcsGovernanceHostOptions = {}
): VcsCommandResult {
  return runVcsMutationWithWorktreeGovernance(
    { operation: 'pr_create', params: publication },
    invocationId,
    print,
    options
  );
}
