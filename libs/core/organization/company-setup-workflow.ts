/** Bounded, transport-independent setup for an already authenticated tenant owner. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContextAsync } from '../authority.js';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import { pathResolver } from '../path-resolver.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { withLock } from '../foundation/lock-utils.js';
import { safeMkdir } from '../secure-io.js';
import { humanActor } from '../actor.js';
import {
  SurfaceManagementError,
  verifySurfaceManagementAuthorization,
  type SurfaceManagementAuthorization,
} from '../surface/surface-management-mutations.js';
import { readTenantProfile } from './tenant-registry.js';
import { onboardAiCompany } from './company-onboarding.js';
import { listCompanyVerticals } from './company-bootstrap.js';
import {
  loadOnboardingContextBinding,
  loadOnboardingFirstWorkRecord,
  resolveOnboardingFirstWork,
  applyOnboardingFirstWork,
} from './onboarding-context.js';
import { loadProjectRecord } from '../project/project-registry.js';
import { loadTenantActivation } from './tenant-activation.js';
import { runTenantActivationProbes } from './tenant-activation-probe.js';
import {
  requestTenantActivationApproval,
  applyApprovedTenantActivation,
} from './tenant-activation-approval.js';
import { loadApprovalRequest } from '../governance/approval-store.js';
import { computeApprovalPresentedDigest } from '../governance/approval-presentation.js';

export type CompanySetupAction =
  | 'status'
  | 'preview_company'
  | 'register_company'
  | 'probe'
  | 'request_activation'
  | 'apply_activation'
  | 'preview_first_work'
  | 'apply_first_work';
export interface CompanySetupCommand {
  action: CompanySetupAction;
  vertical?: string;
  firstWork?: string;
  reviewDigest?: string;
  requestId?: string;
}
interface SetupReceipt {
  registration?: {
    commandHash: string;
    reviewDigest: string;
    state: 'started' | 'completed' | 'failed';
  };
  evidenceRef?: string;
  probePassed?: boolean;
  probeCheckedAt?: string;
  probeSummary?: string[];
  approvalId?: string;
  approvalChannel?: string;
}
interface Readiness {
  vertical?: string;
  accountable_human?: { resource_id?: string };
  first_work?: { goal?: string };
}
function fail(code: string, message: string, status = 409): never {
  throw new SurfaceManagementError(code, status, message);
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scope(auth: SurfaceManagementAuthorization) {
  return {
    customerSlug: auth.tenantSlug,
    tenantSlug: auth.tenantSlug,
    organizationId: auth.tenantSlug,
    tier: 'confidential' as const,
  };
}
function locations(auth: SurfaceManagementAuthorization) {
  const dir = path.join(pathResolver.rootDir(), 'customer', auth.tenantSlug, 'onboarding');
  return {
    dir,
    receipt: path.join(dir, 'web-company-setup.json'),
    readiness: path.join(dir, 'ai-company-readiness.json'),
  };
}
function readReceipt(auth: SurfaceManagementAuthorization): SetupReceipt {
  return readJsonIfPresent<SetupReceipt>(locations(auth).receipt) ?? {};
}
function saveReceipt(auth: SurfaceManagementAuthorization, receipt: SetupReceipt) {
  const p = locations(auth);
  safeMkdir(p.dir, { recursive: true });
  writeJson(p.receipt, receipt);
}
function legacyOwner(auth: SurfaceManagementAuthorization) {
  if (auth.actorId !== humanActor(auth.memberId).id)
    fail('forbidden', 'Verified member identity required.', 403);
  return 'human:' + auth.memberId;
}
function assertOrganizationGrant(auth: SurfaceManagementAuthorization) {
  if (
    auth.allowedOrganizationIds !== 'all' &&
    !auth.allowedOrganizationIds.includes(auth.tenantSlug)
  )
    fail('forbidden', 'Organization access is required.', 403);
}
function assertBinding(auth: SurfaceManagementAuthorization) {
  const b = loadOnboardingContextBinding(auth.tenantSlug);
  if (
    b &&
    (b.tenant_slug !== auth.tenantSlug ||
      b.organization_id !== auth.tenantSlug ||
      b.tier !== 'confidential' ||
      b.owner_id !== legacyOwner(auth))
  )
    fail(
      'accountability_conflict',
      'Existing company accountability differs. Ask its owner to resolve the binding.'
    );
  const r = readJsonIfPresent<Readiness>(locations(auth).readiness);
  if (r?.accountable_human?.resource_id && r.accountable_human.resource_id !== legacyOwner(auth))
    fail('accountability_conflict', 'Existing company responsibility differs.');
  return { binding: b, readiness: r };
}
function approvalSummary(receipt: SetupReceipt, auth: SurfaceManagementAuthorization) {
  if (!receipt.approvalId || !receipt.approvalChannel) return undefined;
  const a = loadApprovalRequest(receipt.approvalChannel, receipt.approvalId);
  if (
    !a ||
    a.scope?.tenant_slug !== auth.tenantSlug ||
    (a.scope?.organization_id && a.scope.organization_id !== auth.tenantSlug)
  )
    return undefined;
  return {
    id: a.id,
    channel: receipt.approvalChannel,
    status: a.revocation
      ? 'revoked'
      : a.applyClaim || a.applyResult || a.consumption
        ? 'used'
        : a.expiresAt && Date.parse(a.expiresAt) <= Date.now()
          ? 'expired'
          : a.status,
    presentedDigest: computeApprovalPresentedDigest(a),
  };
}
function snapshot(auth: SurfaceManagementAuthorization) {
  const tenant = readTenantProfile(auth.tenantSlug);
  if (!tenant)
    fail('tenant_missing', 'Use the existing first-run setup to create an authorized tenant.', 403);
  const { binding, readiness } = assertBinding(auth),
    receipt = readReceipt(auth);
  const activation = loadTenantActivation(scope(auth));
  const first = loadOnboardingFirstWorkRecord(auth.tenantSlug);
  const approval = approvalSummary(receipt, auth);
  const blockers: string[] = [];
  if (approval && ['revoked', 'used'].includes(approval.status) && !activation)
    blockers.push(
      'The previous activation approval cannot be applied again. Run fresh readiness checks and request a new approval.'
    );
  if (
    tenant.isolation_policy?.strict_isolation !== true ||
    tenant.isolation_policy?.allow_cross_distillation === true
  )
    blockers.push(
      'Existing tenant isolation policy needs explicit owner remediation. It will not be changed here.'
    );
  if (receipt.registration && receipt.registration.state !== 'completed')
    blockers.push(
      'Registration was interrupted or failed. Inspect the existing company before retrying; automatic overwrite is disabled.'
    );
  if (binding && !activation)
    blockers.push('Run readiness checks, then approve activation in the signed-in approval queue.');
  return {
    tenantSlug: auth.tenantSlug,
    companyName: tenant.display_name,
    organizationId: auth.tenantSlug,
    verticals: listCompanyVerticals(),
    stage: first
      ? 'first_work_prepared'
      : activation?.status === 'active'
        ? 'active'
        : approval && ['pending', 'approved'].includes(approval.status)
          ? 'awaiting_approval'
          : binding
            ? 'registered'
            : 'unregistered',
    firstWork: readiness?.first_work?.goal ?? '',
    blockers,
    ...(approval ? { activationApproval: approval } : {}),
    registrationState: receipt.registration?.state,
    canRequestActivation:
      receipt.probePassed === true &&
      !!receipt.probeCheckedAt &&
      Date.now() - Date.parse(receipt.probeCheckedAt) >= 0 &&
      Date.now() - Date.parse(receipt.probeCheckedAt) < 15 * 60 * 1000 &&
      (!approval || !['expired', 'rejected', 'revoked', 'used'].includes(approval.status)) &&
      (!receipt.registration || receipt.registration.state === 'completed'),
    probePassed: receipt.probePassed ?? false,
    probeSummary: receipt.probeSummary ?? [],
    execution: 'not_started',
  };
}
function companyInput(auth: SurfaceManagementAuthorization, command: CompanySetupCommand) {
  if (
    typeof command.vertical !== 'string' ||
    !listCompanyVerticals().includes(command.vertical) ||
    typeof command.firstWork !== 'string' ||
    !command.firstWork.trim() ||
    command.firstWork.length > 4000
  )
    fail(
      'invalid_input',
      'Choose a company template and a first request of at most 4000 characters.',
      400
    );
  if (auth.allowedOrganizationIds !== 'all')
    fail('forbidden', 'Company registration requires tenant-wide organization access.', 403);
  const tenant = readTenantProfile(auth.tenantSlug);
  if (!tenant) fail('tenant_missing', 'An existing authorized tenant is required.', 403);
  return {
    vertical: command.vertical,
    slug: auth.tenantSlug,
    tenantSlug: auth.tenantSlug,
    companyName: tenant.display_name,
    firstWork: command.firstWork.trim(),
    accountableHumanId: legacyOwner(auth),
    ownerName: auth.memberId,
  };
}
function reviewHash(auth: SurfaceManagementAuthorization, value: unknown) {
  return hash([
    auth.actorId,
    auth.memberId,
    auth.tenantSlug,
    auth.allowedOrganizationIds,
    auth.allowedProjectIds,
    value,
  ]);
}
function companyReview(auth: SurfaceManagementAuthorization, command: CompanySetupCommand) {
  const input = companyInput(auth, command);
  assertBinding(auth);
  const tenant = readTenantProfile(auth.tenantSlug);
  const digest = reviewHash(auth, [input, tenant]);
  return {
    input,
    digest,
    title: 'Register company',
    summary: [
      input.companyName,
      input.firstWork,
      'Create the company organization and AI worker identity within this tenant.',
      'Budget remains blocked. Activation and external model permissions are separate.',
    ],
  };
}
function firstWorkReview(auth: SurfaceManagementAuthorization) {
  if (auth.allowedProjectIds !== 'all')
    fail('forbidden', 'Preparing a new project requires tenant-wide project access.', 403);
  const { readiness } = assertBinding(auth);
  const intent = readiness?.first_work?.goal;
  if (!intent) fail('company_missing', 'Register a company with a first request.');
  const resolved = resolveOnboardingFirstWork({ customerSlug: auth.tenantSlug, intent });
  const projectId = 'PRJ-' + auth.tenantSlug.toUpperCase() + '-FIRST';
  const prior = loadOnboardingFirstWorkRecord(auth.tenantSlug);
  const existing = resolved.project_required ? loadProjectRecord(projectId) : null;
  if (
    existing &&
    (!prior ||
      prior.management_unit_id !== projectId ||
      prior.tenant_slug !== auth.tenantSlug ||
      prior.organization_id !== auth.tenantSlug ||
      prior.tier !== 'confidential' ||
      existing.tier !== 'confidential' ||
      existing.status !== 'active' ||
      existing.tenant_slug !== auth.tenantSlug ||
      existing.organization_id !== auth.tenantSlug)
  )
    fail(
      'project_conflict',
      'The proposed project already exists or has changed. Resolve it before preparing first work.'
    );
  const input = {
    customerSlug: auth.tenantSlug,
    intent,
    accept: true,
    requireNewProject: !prior,
    ...(resolved.project_required
      ? { bootstrapProject: { projectId, name: intent.slice(0, 80), summary: intent } }
      : {}),
  };
  const digest = reviewHash(auth, [input, resolved, existing, loadTenantActivation(scope(auth))]);
  return {
    input,
    digest,
    title: 'Prepare first work',
    summary: [
      intent,
      'Work shape: ' + resolved.resolution.work_shape,
      'Create the reviewed project/work item only. No mission or model is started.',
    ],
  };
}
/** Authorization is re-read under the lock; the caller supplies only verified principal data. */
export async function executeCompanySetup(
  auth: SurfaceManagementAuthorization,
  command: CompanySetupCommand,
  principal: ResolvedPrincipal
) {
  await verifySurfaceManagementAuthorization(auth);
  assertOrganizationGrant(auth);
  legacyOwner(auth);
  return withExecutionContextAsync(
    'sovereign_concierge',
    () =>
      withLock('company-setup-' + auth.tenantSlug, async () => {
        await verifySurfaceManagementAuthorization(auth);
        assertOrganizationGrant(auth);
        assertBinding(auth);
        let receipt = readReceipt(auth);
        if (command.action === 'status') return { ok: true as const, setup: snapshot(auth) };
        if (command.action === 'preview_company') {
          const { input: _, ...review } = companyReview(auth, command);
          return { ok: true as const, review };
        }
        if (command.action === 'register_company') {
          const review = companyReview(auth, command);
          const commandHash = reviewHash(auth, review.input);
          if (
            receipt.registration?.state === 'completed' &&
            receipt.registration.commandHash === commandHash &&
            receipt.registration.reviewDigest === command.reviewDigest
          )
            return { ok: true as const, setup: snapshot(auth) };
          if (receipt.registration || loadOnboardingContextBinding(auth.tenantSlug))
            fail(
              'registration_conflict',
              'Company setup already exists. Refresh its state; existing records will not be overwritten.'
            );
          if (command.reviewDigest !== review.digest)
            fail('review_changed', 'Review the current company plan before registering.');
          receipt = {
            ...receipt,
            registration: { commandHash, reviewDigest: review.digest, state: 'started' },
          };
          saveReceipt(auth, receipt);
          try {
            const result = onboardAiCompany(review.input);
            if (!result.workerNhiRecorded)
              fail(
                'worker_not_registered',
                'Company files exist, but worker identity registration failed.'
              );
            receipt.registration!.state = 'completed';
            saveReceipt(auth, receipt);
          } catch (error) {
            receipt.registration!.state = 'failed';
            saveReceipt(auth, receipt);
            throw error;
          }
        } else if (command.action === 'probe') {
          if (!loadOnboardingContextBinding(auth.tenantSlug))
            fail('company_missing', 'Register the company first.');
          const result = await runTenantActivationProbes({
            ...scope(auth),
            nhiIds: ['kyberion://agent/' + auth.tenantSlug + '/ceo-operator'],
            serviceIds: [],
          });
          receipt = {
            ...receipt,
            evidenceRef: result.evidence_ref,
            probePassed: result.passed,
            probeCheckedAt: new Date().toISOString(),
            probeSummary: Object.entries(result.results).map(
              ([key, value]) =>
                key +
                ': ' +
                (value.passed ? 'passed' : 'needs attention') +
                (key === 'viewer_scope' && value.detail.includes('=warn')
                  ? ' (audit-only; access denial is not enforced)'
                  : '')
            ),
          };
          const priorApproval = approvalSummary(receipt, auth);
          if (
            priorApproval &&
            ['expired', 'rejected', 'revoked', 'used'].includes(priorApproval.status)
          ) {
            delete receipt.approvalId;
            delete receipt.approvalChannel;
          }
          saveReceipt(auth, receipt);
        } else if (command.action === 'request_activation') {
          if (!receipt.evidenceRef || !snapshot(auth).canRequestActivation)
            fail('probes_required', 'Run and pass the readiness checks first.');
          const requested = await requestTenantActivationApproval(
            auth,
            {
              customerSlug: auth.tenantSlug,
              organizationId: auth.tenantSlug,
              tier: 'confidential',
              nhiIds: ['kyberion://agent/' + auth.tenantSlug + '/ceo-operator'],
              serviceIds: [],
              evidenceRef: receipt.evidenceRef,
            },
            principal
          );
          receipt = {
            ...receipt,
            approvalId: requested.approval.id,
            approvalChannel: requested.approval.channel,
          };
          saveReceipt(auth, receipt);
        } else if (command.action === 'apply_activation') {
          if (!command.requestId || command.requestId !== receipt.approvalId)
            fail('approval_mismatch', 'Refresh and use this company activation request.');
          await applyApprovedTenantActivation(
            auth,
            { approvalRequestId: command.requestId },
            principal
          );
        } else if (command.action === 'preview_first_work') {
          const { input: _, ...review } = firstWorkReview(auth);
          return { ok: true as const, review };
        } else if (command.action === 'apply_first_work') {
          const review = firstWorkReview(auth);
          if (command.reviewDigest !== review.digest)
            fail('review_changed', 'Review the current first-work plan before preparing it.');
          applyOnboardingFirstWork(review.input);
        } else fail('invalid_input', 'Unsupported company setup action.', 400);
        return { ok: true as const, setup: snapshot(auth) };
      }),
    undefined,
    auth.tenantSlug,
    auth.tenantSlug
  );
}
