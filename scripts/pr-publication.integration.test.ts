import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeRmSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { seedFirstJobTestRoot } from './fixtures/first-job-approval-fixture.js';

// The only fake is the external VCS transport. Policy, secure-io, scoped review
// artifacts, charter registry and human-only approval store are the real code.
const CHILD = `
let raw = ''; for await (const part of process.stdin) raw += part;
const input = JSON.parse(raw);
const { publishWithApproval } = await import(input.publisher);
const { runVcsMutationWithApproval, vcsHostInvocationId } = await import('@agent/core/vcs/publication-host');
const { withExecutionContext } = await import('@agent/core/authority');
const { safeReadFile, safeWriteFile } = await import('@agent/core/secure-io');
const { listApprovalRequests, decideApprovalRequest, computeApprovalPresentedDigest } = await import('@agent/core/governance/approval-store');
const { acceptCharter, recordTripwire, loadCharterUsage } = await import('@agent/core/governance/accountability-charter-registry');
const { withPrPublicationRuntime } = await import('@agent/core/governance/pr-publication-runtime');
const { humanActor } = await import('@agent/core/actor');
let effects = 0;
let genericEffects = 0;
let sourceSha = 'a'.repeat(40);
const run = (_command, args) => {
  let stdout;
  if (args[0] === 'repo') stdout = JSON.stringify({ nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo' });
  else if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') stdout = 'false';
  else if (args[0] === 'rev-parse') stdout = sourceSha;
  else if (args[0] === 'ls-remote') stdout = sourceSha + '\tHEAD';
  else if (args[0] === '--no-replace-objects' && args[1] === 'log') stdout = '';
  else if (args[0] === 'remote') stdout = 'https://github.com/fixture/repo.git';
  else if (args[0] === 'symbolic-ref') stdout = 'feature';
  else if (args[0] === 'api') stdout = JSON.stringify({ sha: 'a'.repeat(40) });
  else if (args[0] === 'pr' && args[1] === 'create') { effects++; stdout = 'https://github.com/fixture/repo/pull/1'; }
  else if (args[0] === 'pr' && args[1] === 'view') stdout = JSON.stringify({ number: 1, url: 'https://github.com/fixture/repo/pull/1', headRefOid: sourceSha, baseRefOid: 'b'.repeat(40), baseRefName: 'main', headRefName: 'feature' });
  else if (args[0] === 'push' || (args[0] === 'pr' && args[1] === 'merge')) { genericEffects++; stdout = 'published'; }
  else throw new Error('Unexpected or unapproved VCS effect: ' + args.join(' '));
  return { status: 0, stdout, stderr: '' };
};
const lines = [];
const publish = () => publishWithApproval({ cwd: input.root, title: 'fix(pr): isolated human decision', body: 'Protected full review body', head: 'feature', base: 'main', draft: true }, 'a'.repeat(64), (line) => lines.push(String(line)), run);
let pending;
try { publish(); } catch (error) { pending = error.message; }
const first = listApprovalRequests({ storageChannels: ['external-operation'] });
try { publish(); } catch {}
const second = listApprovalRequests({ storageChannels: ['external-operation'] });
const reviewPath = lines.find((line) => line.includes('Review full publication: '))?.split('Review full publication: ')[1];
if (!reviewPath) throw new Error('No protected review was created: ' + pending);
const review = withExecutionContext('mission_controller', () => JSON.parse(safeReadFile(reviewPath, { encoding: 'utf8' })), 'ecosystem_architect');
if (effects !== 0) throw new Error('An effect ran before human approval');
// Synthetic authenticated human at the store boundary, as in HA-06 tests.
// Production terminal/session proof collection remains outside this fixture.
decideApprovalRequest('mission_controller', { channel: first[0].channel, storageChannel: first[0].storageChannel, requestId: first[0].id, decision: 'approved', decidedBy: 'user:owner', decidedByType: 'human', authenticated: true, authMethod: 'terminal_attested', deciderIdentitySource: 'server_resolved', presentedDigest: computeApprovalPresentedDigest(first[0]), payloadHash: first[0].accountability.payloadHash, effectBinding: first[0].accountability.effectBinding });
const approved = publish();
let duplicate;
try { publish(); } catch (error) { duplicate = error.message; }
const generic = [];
for (const mutation of [ { operation: 'push', params: { cwd: input.root, remote: 'origin', ref: 'feature' } }, { operation: 'pr_merge', params: { cwd: input.root, ref: '1', method: 'squash' } } ]) {
  const invoke = () => runVcsMutationWithApproval(mutation, vcsHostInvocationId(mutation), () => {}, run);
  const priorIds = new Set(listApprovalRequests({ storageChannels: ['external-operation'] }).map((request) => request.id));
  let pending, replay, changed;
  try { invoke(); } catch (error) { pending = error.message; }
  const request = listApprovalRequests({ storageChannels: ['external-operation'] }).find((request) => !priorIds.has(request.id));
  if (!request) throw new Error('No explicit approval request for ' + mutation.operation + ': ' + pending);
  decideApprovalRequest('mission_controller', { channel: request.channel, storageChannel: request.storageChannel, requestId: request.id, decision: 'approved', decidedBy: 'user:owner', decidedByType: 'human', authenticated: true, authMethod: 'terminal_attested', deciderIdentitySource: 'server_resolved', presentedDigest: computeApprovalPresentedDigest(request), payloadHash: request.accountability.payloadHash, effectBinding: request.accountability.effectBinding });
  const resumed = invoke();
  try { invoke(); } catch (error) { replay = error.message; }
  sourceSha = 'c'.repeat(40);
  try { invoke(); } catch (error) { changed = error.message; }
  sourceSha = 'a'.repeat(40);
  generic.push({ operation: mutation.operation, pending, resumed, replay, changed, finalDecision: request.accountability.finalDecision });
}
let unscopedRoleDenied = false;
try { withExecutionContext('pr_publication_store', () => safeReadFile(reviewPath, { encoding: 'utf8' }), 'worker'); } catch { unscopedRoleDenied = true; }
const now = new Date();
withExecutionContext('mission_controller', () => {
  const accepted = acceptCharter({
    draft: {
      charter_id: 'chr-pr-stop', scope: { kind: 'person' },
      accountable: { actor: 'user:owner', authority_basis: { kind: 'self' }, expires_at: new Date(now.getTime() + 86400000).toISOString(), deputies: [] },
      envelope: { money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 }, data_tier: { read: ['public'], write: [] }, external_effects: {}, irreversible: 'named_actions_only', irreversible_named_actions: [] },
      appetite: { max_loss_per_incident: 0, reputational_class_max: 'B', blast_radius_max: { recipients: 1, systems: 1 }, tripwires: ['manual-stop'] },
    },
    statement: 'Fixture human accepts accountability.', acceptedBy: humanActor('owner'), validation: { holder_role: 'owner' }, now,
  });
  recordTripwire(accepted, 'manual-stop', 'Fixture stop');
}, 'ecosystem_architect');
let stopped;
try { publish(); } catch (error) { stopped = error.message; }
let organization;
withExecutionContext('mission_controller', () => {
  safeWriteFile(input.root + '/knowledge/personal/tenants/acme.json', JSON.stringify({ tenant_slug: 'acme', display_name: 'Fixture', status: 'active', assigned_role: 'owner' }));
}, 'ecosystem_architect');
withExecutionContext('mission_controller', () => {
  organization = acceptCharter({ draft: { charter_id: 'chr-org-pr', scope: { kind: 'organization', tenant_slug: 'acme' }, accountable: { actor: 'user:owner', authority_basis: { kind: 'owner', evidence_ref: 'fixture-owner' }, expires_at: new Date(now.getTime() + 86400000).toISOString(), deputies: [] }, envelope: { money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 }, data_tier: { read: ['public'], write: [] }, external_effects: {}, irreversible: 'named_actions_only', irreversible_named_actions: [] }, appetite: { max_loss_per_incident: 0, reputational_class_max: 'B', blast_radius_max: { recipients: 1, systems: 1 }, tripwires: ['org-stop'] } }, statement: 'Fixture owner acceptance', acceptedBy: humanActor('owner'), validation: { holder_role: 'owner' }, now });
}, 'ecosystem_architect', 'acme');
const organizationTripwires = withPrPublicationRuntime({ kind: 'organization', tenant_slug: 'acme' }, 'a'.repeat(64), () => {
  recordTripwire(organization, 'org-stop', 'Real exact ledger write');
  return loadCharterUsage(organization, now).tripwires_hit;
});
process.stdout.write('\\nPR_FIXTURE_RESULT:' + JSON.stringify({ pending, count: first.length, resumedCount: second.length, finalDecision: first[0]?.accountability?.finalDecision, requestScope: first[0]?.scope, review, stopped, unscopedRoleDenied, organizationTripwires, approved, duplicate, effects, generic, genericEffects }) + '\\n');
`;

let root = '';
beforeAll(() => {
  root = pathResolver.shared(`tmp/pr-publication-integration-${randomUUID()}`);
  seedFirstJobTestRoot(pathResolver.rootDir(), root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  safeWriteFile(path.join(root, manifest), safeReadFile(pathResolver.rootResolve(manifest)));
}, 60_000);
afterAll(() => {
  if (root) safeRmSync(root, { recursive: true, force: true });
});

it('clean headless host queues one real human-only request, writes protected review, and honors standing stops', () => {
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
        KYBERION_PERSONA: '',
        SYSTEM_ROLE: '',
        MISSION_ROLE: '',
        MISSION_ID: '',
        KYBERION_TENANT: '',
        KYBERION_CUSTOMER: '',
        KYBERION_NHI_ACTOR: '',
        KYBERION_TIER: 'public',
      },
      input: JSON.stringify({
        root,
        publisher: new URL('./lib/pr-publication.ts', import.meta.url).href,
      }),
      timeoutMs: 60_000,
    }
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const line = result.stdout.split('\n').find((value) => value.startsWith('PR_FIXTURE_RESULT:'));
  expect(line, result.stdout).toBeDefined();
  const response = JSON.parse(line!.slice('PR_FIXTURE_RESULT:'.length));
  expect(response.pending).toContain('EXTERNAL_APPROVAL_REQUIRED');
  expect(response.count).toBe(1);
  expect(response.resumedCount).toBe(1);
  expect(response.finalDecision).toBe('human_only');
  expect(response.requestScope).toMatchObject({ tier: 'public', scope_kind: 'system' });
  expect(response.review).toMatchObject({
    repository: { url: 'https://github.com/fixture/repo' },
    title: 'fix(pr): isolated human decision',
    body: 'Protected full review body',
  });
  expect(response.unscopedRoleDenied).toBe(true);
  expect(response.stopped).toContain('CHARTER_STOP');
  expect(response.organizationTripwires).toContain('org-stop');
  expect(response.approved.status).toBe(0);
  expect(response.effects).toBe(1);
  expect(response.duplicate).toContain('EXTERNAL_EXECUTION_ALREADY_RESERVED');
  expect(response.genericEffects).toBe(2);
  expect(response.generic).toHaveLength(2);
  for (const result of response.generic) {
    expect(result.finalDecision).toBe('human_only');
    expect(result.pending).toContain('EXTERNAL_APPROVAL_REQUIRED');
    expect(result.resumed.status).toBe(0);
    expect(result.replay).toContain('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(result.changed).toContain('EXTERNAL_APPROVAL_REQUIRED');
  }
}, 65_000);
