import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { seedFirstJobTestRoot } from './fixtures/first-job-approval-fixture.js';

// Every child imports these same real built modules. Fixture wrappers replace
// only the final GH transport; the broker, scope ALS, stores and policy are real.
const CHILD = `
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const mod = (name) => import(input.realCore + name + '.js');
const { runVcsMutationWithWorktreeGovernance } = await mod('vcs/governance-host');
const { listApprovalRequests, decideApprovalRequest, computeApprovalPresentedDigest } = await mod('governance/approval-store');
let output;
if (input.action === 'migrate') {
  const { withExecutionContext } = await mod('authority');
  const { safeReadFile, safeExistsSync, safeWriteFile, safeRmSync } = await mod('secure-io');
  const { withScopeEnvOnly } = await mod('scope-context');
  const { loadApprovalRequest } = await mod('governance/approval-store');
  const { previewPublicationRoleMigration, applyPublicationRoleMigration, requestPublicationRoleMigrationApproval } = await mod('organization/publication-role-migration');
  output = withExecutionContext('ecosystem_architect', () => {
    const plan = previewPublicationRoleMigration(input.sourceRoot);
    const previewUnchanged = plan.changes.every((change) => change.before === (safeExistsSync(input.canonical + '/' + change.path) ? safeReadFile(input.canonical + '/' + change.path, 'utf8') : null));
    const request = requestPublicationRoleMigrationApproval(input.sourceRoot, {expectedDigest: plan.digest, requestedBy: 'fixture-role-migration'});
    const approval = loadApprovalRequest('terminal', request.approvalId);
    if (!approval || approval.accountability.finalDecision !== 'human_only') throw new Error('Migration did not create a canonical human-only decision');
    if (!request.reviewPath.includes('/active/shared/artifacts/personal/shared/')) throw new Error('Full migration review is not in the protected personal artifact floor');
    const protectedReview = withScopeEnvOnly(() => JSON.parse(safeReadFile(request.reviewPath, 'utf8')));
    if (JSON.stringify(protectedReview) !== JSON.stringify(plan)) throw new Error('Protected migration review was truncated or changed');
    if ((approval.details || '').includes('authority_role_permissions')) throw new Error('Shared approval copied full policy bytes');
    let pendingBlocked = false;
    try { applyPublicationRoleMigration(input.sourceRoot, {approvalId: approval.id, expectedDigest: plan.digest}); }
    catch (error) { pendingBlocked = error.message.includes('authenticated human approval'); }
    if (!pendingBlocked) throw new Error('Migration admitted a pending nonhuman decision');
    decideApprovalRequest('mission_controller', { channel: approval.channel, storageChannel: approval.storageChannel, requestId: approval.id, decision: 'approved', decidedBy: 'user:owner', decidedByType: 'human', authenticated: true, authMethod: 'terminal_attested', deciderIdentitySource: 'server_resolved', presentedDigest: computeApprovalPresentedDigest(approval), payloadHash: approval.accountability.payloadHash, effectBinding: approval.accountability.effectBinding });
    const applied = applyPublicationRoleMigration(input.sourceRoot, { approvalId: approval.id, expectedDigest: plan.digest });
    // A deliberate installation rollback must not resurrect the old human
    // authorization. This fixture restores bytes only inside its isolated root.
    for (const change of [...plan.changes].reverse()) {
      const file = input.canonical + '/' + change.path;
      if (change.before === null) safeRmSync(file, {force:true}); else safeWriteFile(file, change.before);
    }
    if (previewPublicationRoleMigration(input.sourceRoot).digest !== plan.digest) throw new Error('Fixture rollback did not restore the original exact preview');
    let replayBlocked = false;
    try { applyPublicationRoleMigration(input.sourceRoot, {approvalId: approval.id, expectedDigest: plan.digest}); }
    catch { replayBlocked = true; }
    for (const change of plan.changes) safeWriteFile(input.canonical + '/' + change.path, change.after);
    if (!replayBlocked) throw new Error('Applied migration approval replayed after exact installation rollback');
    return { digest: plan.digest, previewUnchanged, pendingBlocked, replayBlocked, protectedReviewExact: true, changes: applied.changes.map(({path, beforeSha256, afterSha256}) => ({path, beforeSha256, afterSha256})), remaining: previewPublicationRoleMigration(input.sourceRoot).changes.length };
  });
} else if (input.action === 'approve') {
  const requests = listApprovalRequests({ storageChannels: ['external-operation'] });
  const request = requests[0];
  if (!request) throw new Error('Canonical store has no pending request');
  decideApprovalRequest('mission_controller', { channel: request.channel, storageChannel: request.storageChannel, requestId: request.id, decision: 'approved', decidedBy: 'user:owner', decidedByType: 'human', authenticated: true, authMethod: 'terminal_attested', deciderIdentitySource: 'server_resolved', presentedDigest: computeApprovalPresentedDigest(request), payloadHash: request.accountability.payloadHash, effectBinding: request.accountability.effectBinding });
  output = { count: requests.length, scope: request.scope, reviewPaths: request.accountability.reviewArtifacts };
} else {
  const lines = [];
  try {
    const result = runVcsMutationWithWorktreeGovernance({ operation: 'pr_create', params: { cwd: input.worktree, title: 'fix(vcs): cross-worktree human decision', body: 'Exact protected review body', head: 'fixture-head', base: 'main', draft: true } }, 'b'.repeat(64), (line) => lines.push(String(line)), { governanceRoot: input.canonical, bodySourceTier: 'protected_or_unknown' });
    output = { result, lines };
  } catch (error) { output = { error: error.message, lines }; }
}
process.stdout.write('\\nWORKTREE_FIXTURE:' + JSON.stringify(output) + '\\n');
`;

let root = '';
let first = '';
let second = '';
const realCore = `${pathToFileURL(pathResolver.rootResolve('libs/core/dist')).href}/`;
const governance = 'knowledge/product/governance/';
const catalogNames = [
  'security-policy.json',
  'authority-role-index.json',
  'role-assumption-policy.json',
];
const roles = [
  'notification_preferences_reader',
  'tool_runtime_policy_reader',
  'person_charter_store',
  'pr_publication_store',
];
let originalCatalogs = new Map<string, string>();

function gitSource(args: string[]): string {
  const result = safeExecResult('git', args, { cwd: pathResolver.rootDir() });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function withoutMigratedRoles(relative: string, raw: string) {
  const value = JSON.parse(raw);
  if (relative.endsWith('/security-policy.json'))
    for (const role of roles) delete value.authority_role_permissions[role];
  if (relative.endsWith('/authority-role-index.json'))
    for (const role of roles) delete value.authority_roles[role];
  if (relative.endsWith('/role-assumption-policy.json'))
    value.shared_core_roles.roles = value.shared_core_roles.roles.filter(
      (role: string) => !roles.includes(role)
    );
  return value;
}
const git = (args: string[]) => {
  const result = safeExecResult('git', args, { cwd: root });
  expect(result.status, result.stderr || result.stdout).toBe(0);
};

function prepareFixture(legacyWithoutPerson: boolean) {
  root = pathResolver.shared(`tmp/vcs-worktree-approval-${randomUUID()}`);
  first = path.join(root, 'worktrees/first');
  second = path.join(root, 'worktrees/second');
  seedFirstJobTestRoot(pathResolver.rootDir(), root);
  // Exact checked-in catalogs, rather than a latest-policy fixture, reproduce
  // a primary installation whose deployment predates the trusted source host.
  originalCatalogs = new Map();
  const referenceResult = safeExecResult('git', ['rev-parse', '--verify', 'origin/main'], {
    cwd: pathResolver.rootDir(),
  });
  const reference = referenceResult.status === 0 ? referenceResult.stdout.trim() : 'HEAD';
  const omittedRoles = roles.filter(
    (role) => legacyWithoutPerson || role !== 'person_charter_store'
  );
  const rolePaths = gitSource([
    'ls-tree',
    '-r',
    '--name-only',
    reference,
    '--',
    governance + 'authority-roles/',
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const name of safeReaddir(path.join(root, governance, 'authority-roles')))
    safeRmSync(path.join(root, governance, 'authority-roles', name), { force: true });
  for (const relative of [...catalogNames.map((name) => governance + name), ...rolePaths]) {
    let bytes = gitSource(['show', reference + ':' + relative]);
    if (omittedRoles.some((role) => relative === governance + `authority-roles/${role}.json`))
      continue;
    if (catalogNames.some((name) => relative === governance + name)) {
      const value = JSON.parse(bytes);
      const before = JSON.stringify(value);
      if (relative.endsWith('/security-policy.json'))
        for (const role of omittedRoles) delete value.authority_role_permissions[role];
      if (relative.endsWith('/authority-role-index.json'))
        for (const role of omittedRoles) delete value.authority_roles[role];
      if (relative.endsWith('/role-assumption-policy.json'))
        value.shared_core_roles.roles = value.shared_core_roles.roles.filter(
          (role: string) => !omittedRoles.includes(role)
        );
      if (JSON.stringify(value) !== before) bytes = JSON.stringify(value, null, 2) + '\n';
    }
    safeWriteFile(path.join(root, relative), bytes);
    originalCatalogs.set(relative, bytes);
  }
  safeWriteFile(path.join(root, 'package.json'), '{"type":"module"}');
  safeWriteFile(path.join(root, '.gitignore'), 'active/\nknowledge/personal/\nworktrees/\n');
  for (const name of [
    'authority',
    'secure-io',
    'path-resolver',
    'knowledge/memory-promotion-git',
    'vcs/github',
    'scope-context',
  ]) {
    const file = path.join(root, 'libs/core/dist', `${name}.js`);
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, `export * from ${JSON.stringify(`${realCore}${name}.js`)};\n`);
  }
  const publisher = `
import { runVcsMutationWithApproval as real } from ${JSON.stringify(`${realCore}vcs/publication-host.js`)};
import { safeExecResult, safeReadFile, safeWriteFile, safeExistsSync } from ${JSON.stringify(`${realCore}secure-io.js`)};
import { pathResolver } from ${JSON.stringify(`${realCore}path-resolver.js`)};
import { withExecutionContext } from ${JSON.stringify(`${realCore}authority.js`)};
const run = (bin, args, options) => {
  if (bin === 'git') return safeExecResult(bin, args, options);
  let stdout;
  if (args[0] === 'repo') stdout = JSON.stringify({ nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo' });
  else if (args[0] === 'api') {
    const snapshot = safeExecResult('git', ['rev-parse', '--verify', 'fixture-head^{commit}'], options);
    if (snapshot.status !== 0) throw new Error(snapshot.stderr);
    stdout = JSON.stringify({ sha: snapshot.stdout.trim() });
  }
  else if (args[0] === 'pr' && args[1] === 'create') {
    withExecutionContext('mission_controller', () => {
      const file = pathResolver.shared('tmp/effects.txt');
      const previous = safeExistsSync(file) ? Number(safeReadFile(file, { encoding: 'utf8' })) : 0;
      safeWriteFile(file, String(previous + 1));
    }, 'ecosystem_architect');
    stdout = 'https://github.com/fixture/repo/pull/1';
  } else throw new Error('Unexpected external command: ' + args.join(' '));
  return { status: 0, stdout, stderr: '' };
};
export const runVcsMutationWithApproval = (mutation, invocationId, print) => real(mutation, invocationId, print, run);
`;
  safeWriteFile(path.join(root, 'libs/core/dist/vcs/publication-host.js'), publisher);
  git(['init', '--initial-branch=main']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture product policies and module shims',
  ]);
  git(['branch', 'fixture-head']);
  git(['worktree', 'add', '-b', 'first', first]);
  git(['worktree', 'add', '-b', 'second', second]);
  // Source declarations are new, while the canonical installation remains
  // unchanged until an exact human-approved additive migration is applied.
  for (const worktree of [first, second])
    for (const relative of [
      ...catalogNames.map((name) => governance + name),
      ...roles.map((role) => governance + `authority-roles/${role}.json`),
    ])
      safeWriteFile(
        path.join(worktree, relative),
        safeReadFile(pathResolver.rootResolve(relative), { encoding: 'utf8' })
      );
  // Destination persisted defaults must not become the source request scope.
  safeWriteFile(
    path.join(root, 'active/shared/runtime/scope.env'),
    'KYBERION_TIER=confidential\nKYBERION_TENANT=destination-only\n'
  );
}

afterEach(() => {
  if (root) safeRmSync(root, { recursive: true, force: true });
});

function invoke(worktree: string, action = 'publish') {
  const result = safeExecResult(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: worktree,
    env: {
      KYBERION_ROOT: worktree,
      KYBERION_TIER: 'public',
      KYBERION_TENANT: '',
      KYBERION_ORGANIZATION_ID: '',
      KYBERION_PROJECT_ID: '',
      KYBERION_TASK_ID: '',
      KYBERION_NHI_ACTOR: '',
      KYBERION_CUSTOMER: '',
      KYBERION_PERSONA: '',
      SYSTEM_ROLE: '',
      MISSION_ROLE: '',
      MISSION_ID: '',
      KYBERION_SUDO: '',
      KYBERION_SUDO_SCOPE: '',
      KYBERION_SCOPE_ENV_PATH: '',
      VITEST: '',
    },
    input: JSON.stringify({ action, canonical: root, worktree, sourceRoot: first, realCore }),
    timeoutMs: 60_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const line = result.stdout.split('\n').find((value) => value.startsWith('WORKTREE_FIXTURE:'));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice('WORKTREE_FIXTURE:'.length));
}

it.each([false, true])(
  'explicitly migrates an old canonical role installation (person role absent: %s) before sharing one exact human approval across real worktrees',
  (legacyWithoutPerson) => {
    prepareFixture(legacyWithoutPerson);
    const missingRole = invoke(first);
    expect(missingRole.error, JSON.stringify(missingRole)).toContain('EXTERNAL_APPROVAL_REQUIRED');
    expect(missingRole.result).toBeUndefined();
    const repeated = invoke(second);
    expect(repeated.error, JSON.stringify(repeated)).toMatch(
      /ROLE_VIOLATION|EXTERNAL_APPROVAL_REQUIRED/
    );
    const decision = invoke(root, 'approve');
    expect(decision.count).toBe(1);
    expect(decision.scope).toMatchObject({ tier: 'public', scope_kind: 'system' });
    expect(decision.scope.tenant_slug).toBeUndefined();
    const uninstalled = invoke(second);
    expect(uninstalled.error, JSON.stringify(uninstalled)).toMatch(
      /ROLE_VIOLATION|EXTERNAL_RESERVATION_UNAVAILABLE/
    );
    expect(safeExistsSync(path.join(root, 'active/shared/tmp/effects.txt'))).toBe(false);
    for (const [relative, bytes] of originalCatalogs)
      expect(safeReadFile(path.join(root, relative), { encoding: 'utf8' })).toBe(bytes);
    const migration = invoke(root, 'migrate');
    expect(migration.changes.length).toBeGreaterThan(0);
    expect(migration.previewUnchanged).toBe(true);
    expect(migration.pendingBlocked).toBe(true);
    expect(migration.replayBlocked).toBe(true);
    expect(migration.protectedReviewExact).toBe(true);
    expect(migration.remaining).toBe(0);
    for (const change of migration.changes) {
      const installed = String(safeReadFile(path.join(root, change.path), { encoding: 'utf8' }));
      expect(createHash('sha256').update(installed).digest('hex')).toBe(change.afterSha256);
      if (catalogNames.some((name) => change.path === governance + name))
        expect(withoutMigratedRoles(change.path, installed)).toEqual(
          withoutMigratedRoles(change.path, originalCatalogs.get(change.path)!)
        );
    }
    for (const [relative, bytes] of originalCatalogs)
      if (!migration.changes.some((change: { path: string }) => change.path === relative))
        expect(safeReadFile(path.join(root, relative), { encoding: 'utf8' })).toBe(bytes);
    const resumed = invoke(second);
    expect(resumed.result, JSON.stringify(resumed)).toMatchObject({
      status: 0,
      stdout: 'https://github.com/fixture/repo/pull/1',
    });
    const duplicate = invoke(first);
    expect(duplicate.error, JSON.stringify(duplicate)).toContain(
      'EXTERNAL_EXECUTION_ALREADY_RESERVED'
    );
    expect(
      safeReadFile(path.join(root, 'active/shared/tmp/effects.txt'), { encoding: 'utf8' })
    ).toBe('1');
  },
  120_000
);
