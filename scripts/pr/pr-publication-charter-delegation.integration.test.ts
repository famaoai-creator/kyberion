import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeRmSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { seedFirstJobTestRoot } from '../fixtures/first-job-approval-fixture.js';

// The only fake is the external VCS transport. The charter registry, gate,
// resolver and ledger are the real code: a repository-scoped vcs:pr_create
// grant must let publish() dispatch without opening a human approval request.
const CHILD = `
let raw = ''; for await (const part of process.stdin) raw += part;
const input = JSON.parse(raw);
const { publishWithApproval } = await import(input.publisher);
const { withExecutionContext } = await import('@agent/core/authority');
const { listApprovalRequests } = await import('@agent/core/governance/approval-store');
const { acceptCharter, retireCharter, recordTripwire, readCharterLedger } = await import('@agent/core/governance/accountability-charter-registry');
const { withExternalOperationAuthority } = await import('@agent/core/governance/external-operation');
const { createOnboardingExternalOperationAuthority, withInstalledPersonCharterRuntime } = await import('@agent/core/governance/external-operation-runtime');
const { humanActor } = await import('@agent/core/actor');
let effects = 0;
let sourceSha = 'a'.repeat(40);
const run = (_command, args) => {
  let stdout;
  if (args[0] === 'repo') stdout = JSON.stringify({ nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo' });
  else if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') stdout = 'false';
  else if (args[0] === 'rev-parse') stdout = sourceSha;
  else if (args[0] === 'ls-remote') stdout = sourceSha + '	HEAD';
  else if (args[0] === '--no-replace-objects' && args[1] === 'log') stdout = '';
  else if (args[0] === 'remote') stdout = 'https://github.com/fixture/repo.git';
  else if (args[0] === 'symbolic-ref') stdout = 'feature';
  else if (args[0] === 'api') stdout = JSON.stringify({ sha: 'a'.repeat(40) });
  else if (args[0] === 'pr' && args[1] === 'create') { effects++; stdout = 'https://github.com/fixture/repo/pull/1'; }
  else throw new Error('Unexpected or unapproved VCS effect: ' + args.join(' '));
  return { status: 0, stdout, stderr: '' };
};
const publish = () => publishWithApproval({ cwd: input.root, title: 'fix(pr): charter delegated', body: 'Delegated body', head: 'feature', base: 'main', draft: true }, 'b'.repeat(64), () => {}, run);
const now = new Date();
const charterDraft = (id, repo) => ({
  charter_id: id, scope: { kind: 'person' },
  accountable: { actor: 'user:owner', authority_basis: { kind: 'owner', evidence_ref: 'profile:owner' }, expires_at: new Date(now.getTime() + 86400000).toISOString(), deputies: [] },
  envelope: {
    money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
    data_tier: { read: ['public'], write: [] },
    external_effects: {},
    irreversible: 'named_actions_only',
    irreversible_named_actions: ['vcs:pr_create'],
    external_operations: [{ operation_id: 'vcs:pr_create', repository: repo }],
  },
  appetite: { max_loss_per_incident: 0, reputational_class_max: 'B', blast_radius_max: { recipients: 1, systems: 1 }, tripwires: ['manual-stop'] },
});
let delegated = withExecutionContext('mission_controller', () => acceptCharter({ draft: charterDraft('chr-pr-delegate', 'https://github.com/fixture/repo'), statement: 'Fixture human delegates pr_create for fixture/repo.', acceptedBy: humanActor('owner'), validation: { holder_role: 'owner' }, now }), 'ecosystem_architect');
const delegatedAuthority = () =>
  withInstalledPersonCharterRuntime(
    { ownerActor: 'user:owner', agentId: 'kyberion://agent/local/delegated-worker' },
    () =>
      withExternalOperationAuthority(
        createOnboardingExternalOperationAuthority({ scope: { kind: 'person' }, agentId: 'kyberion://agent/local/delegated-worker', ownerActor: 'user:owner', invocationId: 'delegated-invocation' }),
        publish
      )
  );
let delegatedPending;
const delegatedResult = await delegatedAuthority().catch((error) => { delegatedPending = error.message; return undefined; });
const requestsAfterAllow = listApprovalRequests({ storageChannels: ['external-operation'] }).length;
const ledger = withInstalledPersonCharterRuntime(
  { ownerActor: 'user:owner', agentId: 'kyberion://agent/local/delegated-worker' },
  () => readCharterLedger(delegated)
);
// Non-matching grant: replace the charter with one delegating a different repo.
withExecutionContext('mission_controller', () => {
  retireCharter(delegated, humanActor('owner'), 'Grant scope replaced for the next case');
  delegated = acceptCharter({ draft: charterDraft('chr-pr-other-repo', 'https://github.com/acme/other'), statement: 'Different repository grant.', acceptedBy: humanActor('owner'), validation: { holder_role: 'owner' }, replaces: 'chr-pr-delegate', now });
}, 'ecosystem_architect');
let mismatchPending;
await delegatedAuthority().catch((error) => { mismatchPending = error.message; });
// Tripwire: stop wins over any grant.
withExecutionContext('mission_controller', () => recordTripwire(delegated, 'manual-stop', 'Fixture stop'), 'ecosystem_architect');
let stopped;
await delegatedAuthority().catch((error) => { stopped = error.message; });
// Retired charter: the legacy human gate applies unchanged.
withExecutionContext('mission_controller', () => retireCharter(delegated, humanActor('owner'), 'Experiment finished'), 'ecosystem_architect');
let retiredPending;
await delegatedAuthority().catch((error) => { retiredPending = error.message; });
const requestsAtEnd = listApprovalRequests({ storageChannels: ['external-operation'] }).length;
process.stdout.write('\\nPR_CHARTER_RESULT:' + JSON.stringify({ delegatedPending, delegatedResult, effects, requestsAfterAllow, ledger, mismatchPending, stopped, retiredPending, requestsAtEnd }) + '\\n');
`;

let root = '';
beforeAll(() => {
  root = pathResolver.shared(`tmp/pr-charter-delegation-${randomUUID()}`);
  seedFirstJobTestRoot(pathResolver.rootDir(), root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  safeWriteFile(path.join(root, manifest), safeReadFile(pathResolver.rootResolve(manifest)));
}, 60_000);
afterAll(() => {
  if (root) safeRmSync(root, { recursive: true, force: true });
});

it('a repository-scoped vcs:pr_create charter delegates publication; every fallback returns to the human gate', () => {
  const result = safeExecResult(
    process.execPath,
    [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      '--input-type=module',
      '-e',
      CHILD,
    ],
    {
      cwd: pathResolver.rootDir(),
      env: {
        KYBERION_ROOT: root,
        KYBERION_BASE_ROLE: '',
        SYSTEM_ROLE: '',
        MISSION_ROLE: '',
        MISSION_ID: '',
        KYBERION_TENANT: '',
        KYBERION_STANCE: '',
        KYBERION_NHI_ACTOR: '',
        KYBERION_TIER: 'public',
      },
      input: JSON.stringify({
        root,
        publisher: new URL('../lib/pr/pr-publication.ts', import.meta.url).href,
      }),
      timeoutMs: 60_000,
    }
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const line = result.stdout.split('\n').find((value) => value.startsWith('PR_CHARTER_RESULT:'));
  expect(line, result.stdout).toBeDefined();
  const r = JSON.parse(line!.slice('PR_CHARTER_RESULT:'.length));
  // Allow path: the effect ran, no approval request was opened.
  expect(r.delegatedPending).toBeUndefined();
  expect(r.delegatedResult?.stdout).toContain('pull/1');
  expect(r.effects).toBe(1);
  expect(r.requestsAfterAllow).toBe(0);
  expect(r.ledger.some((e: { kind: string }) => e.kind === 'consumption')).toBe(true);
  // Fallbacks: grant mismatch → human gate; tripwire → stop; retired → human gate.
  expect(r.mismatchPending).toContain('EXTERNAL_APPROVAL_REQUIRED');
  expect(r.stopped).toContain('CHARTER_STOP');
  expect(r.retiredPending).toContain('EXTERNAL_APPROVAL_REQUIRED');
  expect(r.effects).toBe(1);
}, 65_000);
