/**
 * AI company onboarding: materialize a vertical, bind human accountability,
 * create the initial AI workforce, and leave one reviewed first-work plan.
 */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { writeJson } from '../foundation/json.js';
import { withExecutionContext } from '../authority.js';
import { ensureAgentIdentityBestEffort } from '../agent/agent-identity.js';
import {
  DEFAULT_TENANT_ISOLATION_POLICY,
  readTenantProfile,
  tenantProfilePath,
  writeTenantProfile,
} from './tenant-registry.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeMkdir,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { applyOnboardingContextBinding } from './onboarding-context.js';
import { loadOrganizationProfileAtPath } from './organization-profile.js';
import { loadOrganizationDomain, saveOrganizationDomain } from './organization-operating-model.js';
import { buildOrganizationDomainRecord } from './organization-operating-model-operations.js';
import {
  getRegisteredEnvText,
  nowIso,
  readTextFile,
  setRegisteredEnv,
} from '../foundation/index.js';
import { bootstrapCompany, listCompanyVerticals } from './company-bootstrap.js';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** The AI worker every company starts with (readiness `workforce[0]`). */
const CEO_OPERATOR_SLUG = 'ceo-operator';

export interface AiCompanyOnboardingInput {
  vertical: string;
  slug: string;
  companyName: string;
  firstWork: string;
  accountableHumanId?: string;
  ownerName?: string;
  tenantSlug?: string;
  rootDir?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface AiCompanyOnboardingResult {
  status: 'planned' | 'ready';
  customerDir: string;
  readinessPath: string;
  firstWorkPath: string;
  contextBindingPath?: string;
  /** Org-chart domains registered in the operating model (`organization domain list`). */
  seededDomains?: string[];
  /** NHI of the declared AI worker (`--nhi-id` for tenant activation). */
  workerNhiId?: string;
  /** False when the NHI ledger refused the write; the id is then only a name. */
  workerNhiRecorded?: boolean;
  writtenFiles: string[];
  nextCommands: string[];
}

function validateInput(input: AiCompanyOnboardingInput): void {
  if (!SLUG_PATTERN.test(input.slug.trim())) {
    throw new Error(`[company-onboard] invalid slug '${input.slug}'`);
  }
  if (!listCompanyVerticals().includes(input.vertical.trim())) {
    throw new Error(
      `[company-onboard] unknown vertical '${input.vertical}'. Available: ${listCompanyVerticals().join(', ')}`
    );
  }
  if (!input.companyName.trim()) throw new Error('[company-onboard] companyName is required');
  if (!input.firstWork.trim()) throw new Error('[company-onboard] firstWork is required');
}

/** The caller-selected checkout root remains an explicit artifact boundary. */
function writeCompanyArtifact(filePath: string, value: unknown, rootDir: string): void {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true, rootDir });
  writeJson(safePath, value);
}

function requireRegularFile(filePath: string, rootDir: string, label: string): string {
  const safePath = assertSafeRepositoryPath(filePath, { rootDir });
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[company-onboard] ${label} must be a regular file`);
  }
  return safePath;
}

interface OrgChartDomain {
  domain_id?: unknown;
  name?: unknown;
  role_ids?: unknown;
}

/**
 * Register the vertical's org-chart domains in the operating model so
 * `pnpm organization domain list` starts from the company's structure instead
 * of empty. The first role of each domain owns it; existing domains are kept.
 */
function seedOrgChartDomains(input: {
  orgChartPath: string;
  organizationId: string;
  tenantSlug: string;
  rootDir: string;
}): string[] {
  if (!safeExistsSync(input.orgChartPath)) return [];
  const chart = JSON.parse(readTextFile(input.orgChartPath)) as { domains?: OrgChartDomain[] };
  const seeded: string[] = [];
  for (const domain of chart.domains ?? []) {
    const roles = Array.isArray(domain.role_ids) ? domain.role_ids : [];
    if (
      typeof domain.domain_id !== 'string' ||
      typeof domain.name !== 'string' ||
      typeof roles[0] !== 'string'
    ) {
      continue;
    }
    const scope = {
      organizationId: input.organizationId,
      tier: 'confidential' as const,
      tenantSlug: input.tenantSlug,
    };
    if (loadOrganizationDomain(domain.domain_id, { ...scope, rootDir: input.rootDir })) continue;
    saveOrganizationDomain(
      buildOrganizationDomainRecord({
        ...scope,
        domainId: domain.domain_id,
        name: domain.name,
        ownerRole: roles[0],
        rootDir: input.rootDir,
      }),
      { rootDir: input.rootDir }
    );
    seeded.push(domain.domain_id);
  }
  return seeded;
}

function snapshotFiles(filePaths: string[], rootDir: string): Map<string, string | undefined> {
  return new Map(
    filePaths.map((filePath) => [
      assertSafeRepositoryPath(filePath, { allowMissingLeaf: true, rootDir }),
      safeExistsSync(assertSafeRepositoryPath(filePath, { allowMissingLeaf: true, rootDir }))
        ? readTextFile(assertSafeRepositoryPath(filePath, { rootDir }))
        : undefined,
    ])
  );
}

/**
 * Best-effort rollback. Returns the files it could not restore instead of
 * throwing, so the caller can still surface the error that caused the
 * rollback (a failed unlink must never mask a policy denial on the first write).
 */
function restoreFiles(snapshots: Map<string, string | undefined>, rootDir: string): string[] {
  const unrestored: string[] = [];
  for (const [filePath, previous] of snapshots) {
    try {
      const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true, rootDir });
      if (previous === undefined) {
        if (safeExistsSync(safePath)) safeUnlinkSync(safePath);
      } else {
        safeMkdir(path.dirname(safePath), { recursive: true });
        safeWriteFile(safePath, previous, { encoding: 'utf8' });
      }
    } catch {
      unrestored.push(filePath);
    }
  }
  return unrestored;
}

export function onboardAiCompany(input: AiCompanyOnboardingInput): AiCompanyOnboardingResult {
  const normalized = {
    ...input,
    vertical: input.vertical.trim(),
    slug: input.slug.trim(),
    companyName: input.companyName.trim(),
    firstWork: input.firstWork.trim(),
    accountableHumanId: input.accountableHumanId?.trim() || 'human:operator',
    ownerName: input.ownerName?.trim() || 'Operator',
    tenantSlug: input.tenantSlug?.trim(),
  };
  validateInput(normalized);
  const rootDir = normalized.rootDir || pathResolver.rootDir();
  const customerDir = assertSafeRepositoryPath(path.join(rootDir, 'customer', normalized.slug), {
    allowMissingLeaf: true,
    rootDir,
  });
  const readinessPath = assertSafeRepositoryPath(
    path.join(customerDir, 'onboarding', 'ai-company-readiness.json'),
    { allowMissingLeaf: true, rootDir }
  );
  const firstWorkPath = assertSafeRepositoryPath(
    path.join(customerDir, 'onboarding', 'first-work-plan.md'),
    { allowMissingLeaf: true, rootDir }
  );
  const tenantSlug = normalized.tenantSlug || '<registered-tenant>';
  const organizationId = normalized.tenantSlug ? normalized.slug : '<organization>';
  const nextCommands = [
    `pnpm stance:switch ${normalized.slug} && source active/shared/runtime/customer.env`,
    'export KYBERION_TENANT_SCOPE_REQUIRED=true',
    // pnpm scripts do not load .env.local: without these exports the governed
    // commands below fail with ROLE_VIOLATION / tenant.scope_missing.
    'export KYBERION_PERSONA=sovereign',
    `export KYBERION_TENANT=${tenantSlug}`,
    // The stance has its own profile root (customer/<slug>/): missions refuse
    // to start until my-identity.json / my-vision.md / agent-identity.json exist there.
    'pnpm onboarding apply --identity <reviewed-identity-json>',
    'pnpm kyberion setup report --persona first-time-user',
    normalized.tenantSlug
      ? `pnpm tenant show ${normalized.tenantSlug} --json`
      : `pnpm tenant create ${tenantSlug} --display-name "${normalized.companyName}" --assigned-role owner --apply`,
    `pnpm onboarding:context bind --customer-slug ${normalized.slug} --tenant-slug ${tenantSlug} --organization-id ${organizationId} --dry-run --json`,
    `pnpm onboarding:context bind --customer-slug ${normalized.slug} --tenant-slug ${tenantSlug} --organization-id ${organizationId} --apply --json`,
    `pnpm tenant:activation plan --customer-slug ${normalized.slug} --tenant-slug ${tenantSlug} --organization-id ${organizationId}`,
    `pnpm tenant:activation probe --customer-slug ${normalized.slug} --tenant-slug ${tenantSlug} --organization-id ${organizationId} --nhi-id kyberion://agent/${normalized.slug}/${CEO_OPERATOR_SLUG}`,
    `# probe prints the activate command citing its evidence; run it with --owner-id ${normalized.accountableHumanId}`,
    `pnpm onboarding:context first-work --customer-slug ${normalized.slug} --intent "${normalized.firstWork}" --dry-run --json`,
    '# after human review: apply first-work, then create and start a governed mission when the work shape requires it',
    // Browser path: local dev IdP + member link makes /login work without an
    // external OIDC provider, then attestation/approvals are operable in
    // concierge Settings (loopback-only; not for production).
    '# browser setup (local dev IdP):',
    'node --import ./scripts/ts-loader.mjs scripts/dev_oidc_idp.ts setup',
    'pnpm surfaces enable --surface dev-idp',
    `pnpm organization member link-identity <member-id> --issuer http://localhost:9099 --subject dev-user`,
    '# open http://localhost:3050/login -> Dev IdP; concierge Settings > Services shows attestation, approvals, charters',
  ];

  if (normalized.dryRun) {
    return {
      status: 'planned',
      customerDir,
      readinessPath,
      firstWorkPath,
      writtenFiles: [],
      nextCommands,
    };
  }

  const profilePath = assertSafeRepositoryPath(
    path.join(customerDir, 'organization-profile.json'),
    { allowMissingLeaf: true, rootDir }
  );
  const templateDir = assertSafeRepositoryPath(
    path.join(pathResolver.rootDir(), 'templates', 'companies', normalized.vertical),
    { rootDir: pathResolver.rootDir() }
  );
  const templatePaths = safeExistsSync(templateDir)
    ? safeReaddir(templateDir).map((entry) =>
        assertSafeRepositoryPath(path.join(customerDir, entry), {
          allowMissingLeaf: true,
          rootDir,
        })
      )
    : [];
  const snapshots = snapshotFiles(
    [...templatePaths, profilePath, readinessPath, firstWorkPath],
    rootDir
  );
  try {
    const bootstrapped = bootstrapCompany({
      vertical: normalized.vertical,
      slug: normalized.slug,
      companyName: normalized.companyName,
      rootDir,
      force: normalized.force,
    });
    const profile = loadOrganizationProfileAtPath(
      requireRegularFile(profilePath, rootDir, 'organization profile')
    );
    profile.accountable_human_resource_id = normalized.accountableHumanId;
    profile.workforce = {
      mode: 'solo_founder_ai_workforce',
      accountable_human_resource_id: normalized.accountableHumanId,
      default_approval_holder: normalized.accountableHumanId,
      default_budget_posture: 'block',
    };
    writeCompanyArtifact(profilePath, profile, rootDir);

    const now = nowIso();
    const readiness = {
      version: '1.0.0',
      status: 'ready_for_first_work',
      organization_id: normalized.slug,
      company_name: normalized.companyName,
      vertical: normalized.vertical,
      accountable_human: {
        resource_id: normalized.accountableHumanId,
        display_name: normalized.ownerName,
        actor_type: 'human',
        final_decision_holder: true,
      },
      workforce: [
        {
          resource_id: `agent:${normalized.slug}:ceo-operator`,
          resource_type: 'agent',
          display_name: 'AI CEO Operator',
          accountable_human_id: normalized.accountableHumanId,
          capabilities: ['planning', 'execution', 'review', 'reporting'],
          status: 'active',
        },
      ],
      boundaries: {
        human_approval_required_for: [
          'contract_signature',
          'payment_or_purchase',
          'external_publication',
          'credential_or_authority_change',
          'hiring_or_termination',
        ],
        ai_can_prepare_but_not_finalize: true,
        budget_posture: 'block',
      },
      first_work: {
        goal: normalized.firstWork,
        status: 'planned',
        created_at: now,
        review_before_execution: true,
      },
    };
    writeCompanyArtifact(readinessPath, readiness, rootDir);
    safeMkdir(path.dirname(firstWorkPath), { recursive: true });
    safeWriteFile(
      firstWorkPath,
      [
        `# First Work Plan: ${normalized.companyName}`,
        '',
        `- Goal: ${normalized.firstWork}`,
        `- Accountable human: ${normalized.accountableHumanId}`,
        `- AI worker: agent:${normalized.slug}:ceo-operator`,
        '- Status: planned (human review required before execution)',
        '',
        '## Next step',
        '- Review this plan and run the mission only after confirming scope, budget, and acceptance criteria.',
        '',
      ].join('\n')
    );
    let contextBindingPath: string | undefined;
    let seededDomains: string[] = [];
    const tenantSlugToBind = normalized.tenantSlug;
    // The tenant registry lives in the personal tier and the binding writes
    // tenant-scoped organization state; both are the same governed onboarding
    // authority `pnpm tenant` assumes, so no operator persona is needed.
    if (tenantSlugToBind)
      withExecutionContext('sovereign_concierge', () => {
        const previousCustomer = getRegisteredEnvText('KYBERION_CUSTOMER');
        setRegisteredEnv('KYBERION_CUSTOMER', normalized.slug);
        const tenantPath = tenantProfilePath(normalized.tenantSlug, {
          rootDir,
          env: { ...process.env, KYBERION_CUSTOMER: normalized.slug },
        });
        const safeTenantPath = assertSafeRepositoryPath(tenantPath, {
          allowMissingLeaf: true,
          rootDir,
        });
        const previousTenantProfile = safeExistsSync(safeTenantPath)
          ? readTextFile(assertSafeRepositoryPath(safeTenantPath, { rootDir }))
          : undefined;
        try {
          const existingTenant = readTenantProfile(normalized.tenantSlug, {
            rootDir,
            env: { ...process.env, KYBERION_CUSTOMER: normalized.slug },
          });
          if (existingTenant && existingTenant.display_name !== normalized.companyName) {
            throw new Error(
              `Tenant '${normalized.tenantSlug}' already belongs to '${existingTenant.display_name}'; refusing to overwrite it during company onboarding.`
            );
          }
          const tenant =
            existingTenant ||
            writeTenantProfile(
              {
                tenant_slug: normalized.tenantSlug,
                tenant_id: normalized.tenantSlug,
                display_name: normalized.companyName,
                status: 'active',
                assigned_role: 'owner',
                isolation_policy: { ...DEFAULT_TENANT_ISOLATION_POLICY },
                metadata: { onboarding_source: 'onboard company', purpose: normalized.firstWork },
              },
              { rootDir, env: { ...process.env, KYBERION_CUSTOMER: normalized.slug } }
            );
          const binding = applyOnboardingContextBinding({
            customerSlug: normalized.slug,
            tenantSlug: tenant.tenant_slug,
            organizationId: normalized.slug,
            tier: 'confidential',
            ownerId: normalized.accountableHumanId,
            organizationName: normalized.companyName,
            purpose: normalized.firstWork,
            rootDir,
          });
          contextBindingPath = binding.saved_paths.find((entry) =>
            entry.endsWith('organization-context.json')
          );
          seededDomains = seedOrgChartDomains({
            orgChartPath: path.join(customerDir, 'org-chart.json'),
            organizationId: normalized.slug,
            tenantSlug: tenant.tenant_slug,
            rootDir,
          });
        } catch (error) {
          try {
            if (previousTenantProfile === undefined) {
              if (safeExistsSync(safeTenantPath)) safeUnlinkSync(safeTenantPath);
            } else safeWriteFile(safeTenantPath, previousTenantProfile, { encoding: 'utf8' });
          } catch {
            // keep the original failure; the outer rollback reports what remains
          }
          throw error;
        } finally {
          setRegisteredEnv('KYBERION_CUSTOMER', previousCustomer);
        }
      });
    // Issue the declared AI worker's NHI so tenant activation's
    // nhi_provisioned probe can pass for a brand-new organization. NHIs are
    // otherwise only recorded when a mission staffs agents, which itself
    // needs an active tenant. Best-effort: a refused ledger write is reported.
    const workerIdentity = withExecutionContext('mission_controller', () =>
      ensureAgentIdentityBestEffort({
        slug: CEO_OPERATOR_SLUG,
        kind: 'agent',
        organizationId: normalized.slug,
        displayName: 'AI CEO Operator',
        accountableHumanId: normalized.accountableHumanId,
        ...(tenantSlugToBind ? { affiliation: { tenant_slug: tenantSlugToBind } } : {}),
      })
    );
    return {
      status: 'ready',
      customerDir,
      readinessPath,
      firstWorkPath,
      ...(contextBindingPath ? { contextBindingPath } : {}),
      ...(seededDomains.length ? { seededDomains } : {}),
      ...(workerIdentity.nhi_id
        ? { workerNhiId: workerIdentity.nhi_id, workerNhiRecorded: workerIdentity.recorded }
        : {}),
      writtenFiles: [
        ...bootstrapped.writtenFiles,
        profilePath,
        readinessPath,
        firstWorkPath,
        ...(contextBindingPath ? [contextBindingPath] : []),
      ],
      nextCommands,
    };
  } catch (error) {
    const unrestored = restoreFiles(snapshots, rootDir);
    if (unrestored.length > 0 && error instanceof Error) {
      error.message += ` (rollback could not restore: ${unrestored.join(', ')})`;
    }
    throw error;
  }
}
