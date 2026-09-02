import * as path from 'node:path';
import { buildCompanyVisionRef, resolveCompany } from '@agent/core/company';
import {
  summarizeApprovalAuditDrilldown,
  summarizeApprovalAuditTrail,
} from '@agent/core/approval-audit';
import { resolveFinanceControllerDecision } from '@agent/core/finance-controller';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import {
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
} from '@agent/core/agent-runtime-supervisor';
import { listSurfaceOutboxMessages } from '@agent/core/surface-coordination-store';
import { discoverProviders } from '@agent/core/provider-discovery';
import { loadSurfaceManifest } from '@agent/core/surface-runtime';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { renderStatus } from '@agent/core/ux-vocabulary';
import { formatDateTime, resolveTimeZone } from '@agent/core/format';
import {
  isServiceConnectionReady,
  loadServiceConnectionReadinessConfig,
} from '@agent/core/service-connection-readiness';
import { loadPersistedTrustLedger } from '@agent/core/trust-engine';
import { loadSkillIndex } from '@agent/core/skill-index';
import { readCanonicalWorkGraph } from '@agent/core/work-graph-projection';
import {
  parseDashboardOrchestrationLine,
  parseDashboardOwnerSummaryLine,
} from '@agent/core/dashboard-event-parser';
import chalk from 'chalk';
import { summarizeBackupStatus } from './backup.js';
import { isRecord, readJson, readTextFile } from '@agent/core/foundation';
import { activeCustomer } from '@agent/core/customer-resolver';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { defineScript, isDirectScript } from './lib/harness.js';

/**
 * Kyberion Sovereign Dashboard v1.0
 * Pure ANSI-based TUI for real-time ecosystem observability.
 */

const PACKAGE_JSON_PATH = pathResolver.rootResolve('package.json');

type DashboardFocus = 'all' | 'onboarding' | 'capabilities' | 'skills';
type DashboardLog = (...values: unknown[]) => void;

let dashboardLog: DashboardLog = (...values) => console.log(...values);

function resolveDashboardTenantSlug(): string | null {
  const onboardingState = readJsonIfExists<{
    tenants?: { entries?: Array<{ tenant_slug: string }> };
  }>(path.join(resolveActiveProfileRoot(), 'onboarding/onboarding-state.json'));
  const onboardingTenant = onboardingState?.tenants?.entries?.[0]?.tenant_slug?.trim();
  return onboardingTenant || activeCustomer() || null;
}

function getDashboardFocus(argv: string[] = []): DashboardFocus {
  const focusIndex = argv.indexOf('--focus');
  const focusValue =
    focusIndex >= 0
      ? String(argv[focusIndex + 1] || '')
          .trim()
          .toLowerCase()
      : '';
  if (focusValue === 'capabilities') return 'capabilities';
  if (focusValue === 'skills') return 'skills';
  return focusValue === 'onboarding' ? 'onboarding' : 'all';
}

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function getDashboardVersion(): string {
  const packageJson = readJsonIfExists<{ version?: string }>(PACKAGE_JSON_PATH);
  return packageJson?.version || 'unknown';
}

type DashboardDoctorFinding = { severity: 'critical' | 'warning'; agentId: string; reason: string };

type DashboardMissionState = {
  mission_id: string;
  status: 'active';
  tier?: 'personal' | 'confidential' | 'public';
  mission_type?: string;
  tenant_slug?: string;
};

export function readMissionDashboardState(statePath: string): DashboardMissionState | null {
  try {
    const value = readJson<unknown>(statePath);
    if (!isRecord(value) || value.status !== 'active' || typeof value.mission_id !== 'string') {
      return null;
    }
    const tier =
      value.tier === 'personal' || value.tier === 'confidential' || value.tier === 'public'
        ? value.tier
        : undefined;
    return {
      mission_id: value.mission_id,
      status: 'active',
      ...(tier ? { tier } : {}),
      ...(typeof value.mission_type === 'string' ? { mission_type: value.mission_type } : {}),
      ...(typeof value.tenant_slug === 'string' ? { tenant_slug: value.tenant_slug } : {}),
    };
  } catch {
    return null;
  }
}

function collectRuntimeDoctorFindings(): DashboardDoctorFinding[] {
  const missions = new Set<string>();
  const missionDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
  ];
  for (const dir of missionDirs) {
    for (const item of safeListDir(dir)) {
      let statePath: string;
      try {
        const missionPath = assertSafeRepositoryPath(path.join(dir, item));
        statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'), {
          allowMissingLeaf: true,
        });
      } catch {
        continue;
      }
      if (!safeExistsSync(statePath)) continue;
      const state = readMissionDashboardState(statePath);
      if (state) {
        missions.add(state.mission_id);
      }
    }
  }

  const runtimeSnapshots = new Map(
    listAgentRuntimeSnapshots().map((snapshot) => [snapshot.agent.agentId, snapshot])
  );
  const findings: DashboardDoctorFinding[] = [];
  for (const lease of listAgentRuntimeLeaseSummaries()) {
    const runtime = runtimeSnapshots.get(lease.agent_id);
    if (!runtime) continue;
    if (lease.owner_type === 'mission' && !missions.has(lease.owner_id)) {
      findings.push({
        severity: 'critical' as const,
        agentId: lease.agent_id,
        reason: 'orphaned mission lease',
      });
      continue;
    }
    if (runtime.agent.status === 'error') {
      findings.push({
        severity: 'warning' as const,
        agentId: lease.agent_id,
        reason: 'runtime in error state',
      });
      continue;
    }
    const executionMode =
      typeof lease.metadata?.execution_mode === 'string'
        ? lease.metadata.execution_mode
        : undefined;
    const channel =
      typeof lease.metadata?.channel === 'string' ? lease.metadata.channel : undefined;
    if (
      executionMode === 'conversation' &&
      channel === 'slack' &&
      runtime.runtime?.idleForMs &&
      runtime.runtime.idleForMs > 5 * 60 * 1000
    ) {
      findings.push({
        severity: 'warning' as const,
        agentId: lease.agent_id,
        reason: 'stale slack conversation lease',
      });
    }
  }
  return findings.slice(0, 6);
}

function getDashboardHealthStatus(): 'OPERATIONAL' | 'DEGRADED' {
  return collectRuntimeDoctorFindings().length > 0 ? 'DEGRADED' : 'OPERATIONAL';
}

function drawHeader() {
  const identity = readJsonIfExists<{ name?: string }>(
    path.join(resolveActiveProfileRoot(), 'my-identity.json')
  );
  const status = getDashboardHealthStatus();
  dashboardLog(
    chalk.bold.cyan(` 🌌 KYBERION SOVEREIGN ECOSYSTEM | CEO DASHBOARD v${getDashboardVersion()} `)
  );
  dashboardLog(chalk.dim(' --------------------------------------------------- '));
  dashboardLog(
    ` Status: ${status === 'OPERATIONAL' ? chalk.green(renderStatus('connection', 'connected', 'en').toUpperCase()) : chalk.yellow(renderStatus('connection', 'degraded', 'en').toUpperCase())} | User: ${chalk.bold(identity?.name || 'Operator')} | Time: ${formatDateTime(new Date(), { locale: resolveOperatorLocale(), timeZone: resolveTimeZone(), style: 'time' })}\n`
  );
}

function drawCompanyOverview() {
  dashboardLog(chalk.bold.blue(' 🏢 COMPANY OVERVIEW'));

  const tenantSlug = resolveDashboardTenantSlug();
  const company = resolveCompany(tenantSlug);
  const expectedVisionRef = buildCompanyVisionRef(company.tenant_slug);
  const visionSource = `${company.vision_ref.source_kind} · ${company.vision_ref.source_path}`;
  const topRoles =
    company.org_chart_ref.data?.positions
      ?.filter((position) => position.reports_to == null)
      .map((position) => position.role_id) || [];
  const decisionRightsCount = company.decision_rights_ref.data?.decisions.length || 0;
  const approvalAudit = summarizeApprovalAuditTrail(6);
  const approvalAuditDrilldown = summarizeApprovalAuditDrilldown(6);
  const financeController = resolveFinanceControllerDecision({ tenantSlug: company.tenant_slug });
  const okrRef = company.okr_ref || null;
  const okrSummary = okrRef?.data
    ? {
        objectiveCount: okrRef.data.objectives.length,
        keyResultCount: okrRef.data.objectives.reduce(
          (count, objective) => count + objective.key_results.length,
          0
        ),
        progressPercent:
          okrRef.data.objectives.length > 0
            ? Math.round(
                (okrRef.data.objectives
                  .flatMap((objective) => objective.key_results)
                  .filter((keyResult) => {
                    if (
                      typeof keyResult.current === 'number' &&
                      typeof keyResult.target === 'number'
                    ) {
                      return keyResult.current >= keyResult.target;
                    }
                    if (
                      typeof keyResult.current === 'string' &&
                      typeof keyResult.target === 'string'
                    ) {
                      return keyResult.current === keyResult.target;
                    }
                    return false;
                  }).length /
                  okrRef.data.objectives.flatMap((objective) => objective.key_results).length) *
                  100
              )
            : 0,
      }
    : null;

  dashboardLog(
    `  ${chalk.gray('•')} Company: ${chalk.cyan(company.name)} ${chalk.dim(`(${company.company_id})`)}`
  );
  dashboardLog(`  ${chalk.gray('•')} Sovereign: ${chalk.white(company.sovereign || 'unknown')}`);
  dashboardLog(`  ${chalk.gray('•')} Vision ref: ${chalk.white(expectedVisionRef)}`);
  dashboardLog(`  ${chalk.gray('•')} Vision: ${chalk.white(visionSource)}`);
  dashboardLog(
    `  ${chalk.gray('•')} Org chart: ${company.org_chart_ref.data?.positions.length || 0} positions / ${company.org_chart_ref.data?.domains.length || 0} domains`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Top-level roles: ${topRoles.length > 0 ? chalk.green(topRoles.join(', ')) : chalk.dim('none')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Financial: ${company.financial_ref.exists ? chalk.green('available') : chalk.dim('missing')} | Decision rights: ${company.decision_rights_ref.exists ? chalk.green('available') : chalk.dim('missing')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Finance controller: ${chalk.white(financeController.mode)}${financeController.shouldCutCosts ? chalk.red(' (cost cutting)') : ''}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} OKR: ${okrSummary ? chalk.green(`${okrSummary.objectiveCount} objectives / ${okrSummary.keyResultCount} KRs / ${okrSummary.progressPercent}%`) : chalk.dim('missing')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Approval audit: ${chalk.white(`${approvalAudit.total} entries (${approvalAudit.allowed} allowed / ${approvalAudit.denied} denied)`)}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Audit drill-down: ${chalk.white(`${approvalAuditDrilldown.byDecisionType.length} decision types / ${approvalAuditDrilldown.byCorrelationId.length} correlation chains`)}`
  );
  if (company.decision_rights_ref.data) {
    dashboardLog(
      `  ${chalk.gray('•')} Decision policy: ${chalk.white(`${decisionRightsCount} rules from ${company.decision_rights_ref.data.source_kind}`)}`
    );
  }
  dashboardLog('');
}

function readJsonIfExists<T>(logicalPath: string): T | null {
  try {
    const safePath = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return readJson<T>(safePath);
  } catch {
    return null;
  }
}

type ProviderCapabilitySnapshot = {
  generated_at: string;
  registered_capabilities: number;
  available_capabilities: number;
  available_providers: string[];
  missing_providers: string[];
  providers: Array<{
    provider: string;
    installed: boolean;
    version: string | null;
    protocol: string;
    healthy: boolean;
  }>;
  capabilities: Array<{
    capability_id: string;
    provider: string;
    status: string;
    discovery_status: string;
    evidence?: string;
  }>;
};

export function listJsonFiles(dir: string): string[] {
  try {
    const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
    if (!safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) return [];
    return safeReaddir(safeDir)
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const safeFile = assertSafeRepositoryPath(path.join(safeDir, entry));
          return safeLstat(safeFile).isFile() ? [safeFile] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function safeListDir(dir: string): string[] {
  try {
    const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
    if (!safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) return [];
    return safeReaddir(safeDir).filter((entry) => {
      try {
        const child = assertSafeRepositoryPath(path.join(safeDir, entry), {
          allowMissingLeaf: true,
        });
        return safeLstat(child).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readConnectionReview() {
  const connectionDir = path.join(resolveActiveProfileRoot(), 'connections');
  const readiness = loadServiceConnectionReadinessConfig();
  const files = listJsonFiles(connectionDir);

  const services = files.map((file) => {
    const serviceId = path.basename(file, '.json');
    const record = readJsonIfExists<Record<string, unknown>>(file);
    const requirements = readiness?.required_services?.[serviceId]?.required_keys_any || [];
    const status = !record
      ? 'pending'
      : isServiceConnectionReady(serviceId, record)
        ? 'ready'
        : 'blocked';
    return {
      serviceId,
      status,
      record,
      requirements,
    };
  });

  const blocked = Object.entries(readiness?.required_services || {})
    .filter(([serviceId]) => !services.some((entry) => entry.serviceId === serviceId))
    .map(([serviceId]) => ({
      serviceId,
      status: 'missing',
      record: null,
      requirements: readiness?.required_services?.[serviceId]?.required_keys_any || [],
    }));

  return {
    services: [...services, ...blocked],
    readiness,
  };
}

function drawTenantContext() {
  dashboardLog(chalk.bold.cyan(' 🧩 TENANT CONTEXT'));

  const onboardingState = readJsonIfExists<{
    identity?: { name?: string };
    tenants?: {
      entries?: Array<{ tenant_slug: string; display_name?: string; assigned_role?: string }>;
    };
  }>(path.join(resolveActiveProfileRoot(), 'onboarding/onboarding-state.json'));
  const tenants = onboardingState?.tenants?.entries || [];

  if (tenants.length === 0) {
    dashboardLog(chalk.dim('  (No tenant registered yet)'));
    dashboardLog('');
    return;
  }

  const activeTenant = tenants[0];
  dashboardLog(
    `  ${chalk.gray('•')} Active: ${chalk.cyan(activeTenant.tenant_slug)} ${chalk.dim(activeTenant.display_name || '')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Role: ${chalk.white(activeTenant.assigned_role || 'unknown')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Owner: ${chalk.white(onboardingState?.identity?.name || 'Sovereign')}`
  );
  if (tenants.length > 1) {
    dashboardLog(
      `  ${chalk.gray('•')} Other tenants: ${chalk.dim(
        tenants
          .slice(1)
          .map((tenant) => tenant.tenant_slug)
          .join(', ')
      )}`
    );
  }
  dashboardLog('');
}

function drawConnectionReview() {
  dashboardLog(chalk.bold.magenta(' 🔍 CONNECTION REVIEW'));

  const review = readConnectionReview();
  const services = review.services;
  const ready = services.filter((entry) => entry.status === 'ready');
  const blocked = services.filter(
    (entry) => entry.status === 'blocked' || entry.status === 'missing'
  );
  const pending = services.filter((entry) => entry.status === 'pending');

  dashboardLog(
    `  ${chalk.gray('•')} Ready: ${ready.length > 0 ? chalk.green(ready.length) : chalk.dim(0)}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Blocked: ${blocked.length > 0 ? chalk.yellow(blocked.length) : chalk.dim(0)}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Pending: ${pending.length > 0 ? chalk.yellow(pending.length) : chalk.dim(0)}`
  );

  const recommended =
    blocked.length > 0
      ? `review ${blocked[0].serviceId}`
      : pending.length > 0
        ? `capture ${pending[0].serviceId}`
        : 'all required connection drafts are available';
  dashboardLog(`  ${chalk.gray('•')} Review cue: ${chalk.white(recommended)}`);

  for (const entry of services.slice(0, 5)) {
    const renderedStatus = renderStatus('connection', entry.status, 'en').toUpperCase();
    const label =
      entry.status === 'ready'
        ? chalk.green(renderedStatus)
        : entry.status === 'blocked'
          ? chalk.yellow(renderedStatus)
          : entry.status === 'missing'
            ? chalk.red(renderedStatus)
            : chalk.dim(renderedStatus);
    const requirements =
      entry.requirements.length > 0 ? chalk.dim(` needs=${entry.requirements.join('|')}`) : '';
    dashboardLog(`  ${chalk.gray('•')} ${entry.serviceId.padEnd(16)} [${label}]${requirements}`);
  }
  dashboardLog('');
}

function drawStarterMissionSuggestion() {
  dashboardLog(chalk.bold.yellow(' 🎯 STARTER MISSION'));

  const onboardingState = readJsonIfExists<{
    status?: string;
    tutorial?: { mode?: string };
    tenants?: { entries?: Array<{ tenant_slug: string; display_name?: string }> };
  }>(path.join(resolveActiveProfileRoot(), 'onboarding/onboarding-state.json'));

  const connectionReview = readConnectionReview();
  const readyServices = connectionReview.services
    .filter((entry) => entry.status === 'ready')
    .map((entry) => entry.serviceId);
  const blockedServices = connectionReview.services
    .filter((entry) => entry.status === 'blocked' || entry.status === 'missing')
    .map((entry) => entry.serviceId);
  const tenantEntries = onboardingState?.tenants?.entries || [];
  const tutorialMode = onboardingState?.tutorial?.mode || 'skipped';

  const suggestion =
    !onboardingState || onboardingState.status !== 'complete'
      ? {
          intentId: 'launch-first-run-onboarding',
          title: 'Run onboarding to finish setup',
          why: 'Onboarding is not complete yet.',
        }
      : blockedServices.length > 0
        ? {
            intentId: 'verify-environment-readiness',
            title: 'Verify blocked service readiness',
            why: `Blocked services remain: ${blockedServices.join(', ')}.`,
          }
        : tenantEntries.length === 0
          ? {
              intentId: 'configure-organization-toolchain',
              title: 'Register the first tenant toolchain',
              why: 'No tenant is registered yet, so the next useful step is organization setup.',
            }
          : tutorialMode === 'skipped'
            ? {
                intentId: 'register-presentation-preference-profile',
                title: 'Capture a reusable preference profile',
                why: 'Tenant and service setup are available; a lightweight preference capture gives the first durable win.',
              }
            : {
                intentId: 'register-presentation-preference-profile',
                title: 'Refine presentation defaults',
                why: 'The environment is ready for reusable preference capture.',
              };

  dashboardLog(`  ${chalk.gray('•')} Intent: ${chalk.cyan(suggestion.intentId)}`);
  dashboardLog(`  ${chalk.gray('•')} Suggestion: ${chalk.white(suggestion.title)}`);
  dashboardLog(`  ${chalk.gray('•')} Why: ${chalk.dim(suggestion.why)}`);
  dashboardLog(
    `  ${chalk.gray('•')} Ready services: ${readyServices.length > 0 ? chalk.green(readyServices.join(', ')) : chalk.dim('none')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Next action: ${chalk.white(`create a mission from ${suggestion.intentId} in the current tenant context`)}`
  );
  dashboardLog('');
}

function drawCapabilityLandscape() {
  dashboardLog(chalk.bold.cyan(' 🧰 PROVIDER CAPABILITY LANDSCAPE'));

  const snapshotPath = pathResolver.rootResolve('active/shared/runtime/provider-capabilities.json');
  const snapshot = readJsonIfExists<ProviderCapabilitySnapshot>(snapshotPath);
  const discovery = discoverProviders();

  if (!snapshot) {
    dashboardLog(chalk.dim('  (No capability snapshot yet)'));
    dashboardLog(chalk.dim('  Run `pnpm provider-capabilities:scan` to capture one.'));
    dashboardLog('');
    return;
  }

  const installedProviders = discovery.filter((provider) => provider.installed);
  const activeProviders = snapshot.providers.filter(
    (provider) => provider.installed && provider.healthy
  );
  const missingProviders = snapshot.missing_providers;
  const previewCapabilities = snapshot.capabilities.slice(0, 5);

  dashboardLog(`  ${chalk.gray('•')} Generated: ${chalk.white(snapshot.generated_at)}`);
  dashboardLog(
    `  ${chalk.gray('•')} Registered: ${chalk.cyan(snapshot.registered_capabilities)} capabilities`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Available: ${chalk.green(snapshot.available_capabilities)} capabilities`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Providers: ${activeProviders.length > 0 ? chalk.green(activeProviders.length) : chalk.dim(0)} healthy / ${installedProviders.length} installed`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Available providers: ${snapshot.available_providers.length > 0 ? chalk.green(snapshot.available_providers.join(', ')) : chalk.dim('none')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Missing providers: ${missingProviders.length > 0 ? chalk.yellow(missingProviders.join(', ')) : chalk.dim('none')}`
  );

  if (previewCapabilities.length > 0) {
    dashboardLog(chalk.dim('  Top capabilities:'));
    for (const capability of previewCapabilities) {
      const status =
        capability.discovery_status === 'available'
          ? chalk.green(renderStatus('provider', 'available', 'en'))
          : chalk.yellow(renderStatus('provider', 'missing', 'en'));
      dashboardLog(
        `    ${chalk.gray('•')} ${capability.capability_id.padEnd(38)} ${chalk.dim(capability.provider)} ${status}`
      );
    }
  }
  dashboardLog('');
}

function drawSkillLandscape() {
  dashboardLog(chalk.bold.green(' 🧠 GOVERNED SKILL LANDSCAPE'));

  let skillIndex: ReturnType<typeof loadSkillIndex> | null = null;
  try {
    skillIndex = loadSkillIndex();
  } catch {
    // Preserve the dashboard's safe, actionable empty-state behavior when
    // the generated catalog is absent or invalid.
    skillIndex = null;
  }

  if (!skillIndex || !Array.isArray(skillIndex.s) || skillIndex.s.length === 0) {
    dashboardLog(chalk.dim('  (No governed skill catalog found)'));
    dashboardLog(chalk.dim('  Run `pnpm kyberion sync component-inventory` to refresh the index.'));
    dashboardLog('');
    return;
  }

  const implemented = skillIndex.s.filter((entry) => entry.s === 'implemented');
  const preview = skillIndex.s.slice(0, 5);

  dashboardLog(`  ${chalk.gray('•')} Version: ${chalk.white(skillIndex.v || 'unknown')}`);
  dashboardLog(`  ${chalk.gray('•')} Last updated: ${chalk.white(skillIndex.u || 'unknown')}`);
  dashboardLog(
    `  ${chalk.gray('•')} Skills: ${implemented.length > 0 ? chalk.green(implemented.length) : chalk.dim(0)} implemented / ${skillIndex.s.length}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Catalog: ${chalk.cyan(pathResolver.knowledge('product/orchestration/global_skill_index.json'))}`
  );

  if (preview.length > 0) {
    dashboardLog(chalk.dim('  Top skills:'));
    for (const skill of preview) {
      dashboardLog(
        `    ${chalk.gray('•')} ${skill.n.padEnd(28)} ${chalk.dim(skill.version || 'unknown')} ${chalk.white(skill.d.slice(0, 56))}`
      );
    }
  }
  dashboardLog('');
}

function drawOnboardingHome() {
  dashboardLog(chalk.bold.green(' 🏠 ONBOARDING HOME'));

  const onboardingStatePath = path.join(
    resolveActiveProfileRoot(),
    'onboarding/onboarding-state.json'
  );
  const onboardingState = readJsonIfExists<{
    status?: string;
    current_phase?: string;
    completed_phases?: string[];
    identity?: {
      name?: string;
      agent_id?: string;
      language?: string;
      interaction_style?: string;
      primary_domain?: string;
    };
    services?: {
      candidates?: Array<{ service_id: string; status?: string; connection_kind?: string }>;
    };
    tenants?: {
      entries?: Array<{ tenant_slug: string; display_name?: string; assigned_role?: string }>;
    };
    tutorial?: { mode?: string; summary?: string };
  }>(onboardingStatePath);

  const connectionDir = path.join(resolveActiveProfileRoot(), 'connections');
  const tenantDir = path.join(resolveActiveProfileRoot(), 'tenants');
  const connectionFiles = listJsonFiles(connectionDir);
  const tenantFiles = listJsonFiles(tenantDir);
  const readiness = loadServiceConnectionReadinessConfig();

  const serviceMap = new Map<string, Record<string, unknown>>();
  for (const file of connectionFiles) {
    const serviceId = path.basename(file, '.json');
    const payload = readJsonIfExists<Record<string, unknown>>(file);
    if (payload) serviceMap.set(serviceId, payload);
  }

  const requiredServices = Object.entries(readiness?.required_services || {});
  const readyServices: string[] = [];
  const blockedServices: string[] = [];
  for (const [serviceId] of requiredServices) {
    const record = serviceMap.get(serviceId);
    if (record && isServiceConnectionReady(serviceId, record)) readyServices.push(serviceId);
    else blockedServices.push(serviceId);
  }

  const onboardingComplete = onboardingState?.status === 'complete';
  const phaseLabel = onboardingState?.current_phase || 'identity';
  const identity = onboardingState?.identity;
  const tenantEntries = onboardingState?.tenants?.entries || [];
  const tutorial = onboardingState?.tutorial;

  dashboardLog(
    `  ${chalk.gray('•')} State: ${onboardingComplete ? chalk.green('complete') : chalk.yellow('draft')} ${chalk.dim(`phase=${phaseLabel}`)}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Identity: ${chalk.cyan(identity?.name || 'Sovereign')} ${chalk.dim(`/${identity?.agent_id || 'KYBERION-PRIME'}`)}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Services: ${readyServices.length > 0 ? chalk.green(`${readyServices.length} ready`) : chalk.dim('0 ready')} / ${blockedServices.length > 0 ? chalk.yellow(`${blockedServices.length} blocked`) : chalk.dim('0 blocked')}`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Tenants: ${tenantFiles.length > 0 ? chalk.green(tenantFiles.length) : chalk.dim(0)} registered`
  );
  dashboardLog(
    `  ${chalk.gray('•')} Tutorial: ${tutorial?.mode ? chalk.cyan(tutorial.mode) : chalk.dim('not started')}`
  );

  const recommendedNextAction = !onboardingComplete
    ? 'Run `pnpm onboard` (customer/{slug}/ preferred when KYBERION_CUSTOMER is set) and resume the current phase.'
    : blockedServices.length > 0
      ? `Review ${blockedServices.join(', ')} connection drafts.`
      : tenantEntries.length === 0
        ? 'Register the first tenant and then choose a starter mission.'
        : 'Pick a starter mission from the current tenant context.';

  dashboardLog(`  ${chalk.gray('•')} Next: ${chalk.white(recommendedNextAction)}`);

  if (connectionFiles.length > 0) {
    dashboardLog(chalk.dim('  Connections:'));
    for (const file of connectionFiles.slice(0, 4)) {
      const serviceId = path.basename(file, '.json');
      const status =
        serviceMap.has(serviceId) && isServiceConnectionReady(serviceId, serviceMap.get(serviceId)!)
          ? chalk.green(renderStatus('connection', 'connected', 'en'))
          : chalk.yellow(renderStatus('connection', 'pending', 'en'));
      dashboardLog(`    ${chalk.gray('•')} ${serviceId.padEnd(16)} ${status}`);
    }
  } else {
    dashboardLog(chalk.dim('  Connections: none captured yet'));
  }
  dashboardLog('');
}

function drawMissions() {
  const missionDirs = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
    pathResolver.knowledge('personal/missions'),
  ];

  dashboardLog(chalk.bold.yellow(' 📋 ACTIVE MISSIONS'));
  let count = 0;
  for (const dir of missionDirs) {
    for (const item of safeListDir(dir)) {
      let missionPath: string;
      let statePath: string;
      try {
        missionPath = assertSafeRepositoryPath(path.join(dir, item));
        statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'), {
          allowMissingLeaf: true,
        });
      } catch {
        continue;
      }
      if (safeExistsSync(statePath)) {
        const state = readMissionDashboardState(statePath);
        if (state) {
          const color = state.tier === 'personal' ? chalk.magenta : chalk.blue;
          let planReady = false;
          try {
            planReady = safeExistsSync(
              assertSafeRepositoryPath(path.join(missionPath, 'PLAN.md'), {
                allowMissingLeaf: true,
              })
            );
          } catch {
            continue;
          }
          const nextTaskCount = (() => {
            try {
              return readCanonicalWorkGraph(state.mission_id, {
                ...(state.tenant_slug ? { tenantSlug: state.tenant_slug } : {}),
              }).items.length;
            } catch {
              return 0;
            }
          })();
          const planning = planReady ? chalk.green('PLAN READY') : chalk.yellow('PLANNING');
          dashboardLog(
            `  ${chalk.gray('•')} ${color(state.mission_id.padEnd(25))} [${chalk.green(renderStatus('mission', state.status, 'en').toUpperCase())}] ${chalk.dim(state.mission_type || 'development')} ${chalk.gray(`next=${nextTaskCount}`)} ${planning}`
          );
          count++;
        }
      }
    }
  }
  if (count === 0) dashboardLog(chalk.dim('  (No active missions)'));
  dashboardLog('');
}

function drawMissionOrchestration() {
  const eventsPath = pathResolver.shared(
    'observability/mission-control/orchestration-events.jsonl'
  );
  const slackMissionsPath = pathResolver.shared('observability/channels/slack/missions.jsonl');

  dashboardLog(chalk.bold.cyan(' 🧭 MISSION ORCHESTRATION'));

  const events: Array<{ ts: string; decision: string; mission?: string; why?: string }> = [];
  for (const file of [eventsPath, slackMissionsPath]) {
    if (!safeExistsSync(file)) continue;
    const raw = readTextFile(file);
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      const event = parseDashboardOrchestrationLine(line);
      if (event) events.push(event);
    }
  }

  if (events.length === 0) {
    dashboardLog(chalk.dim('  (No orchestration events yet)'));
    dashboardLog('');
    return;
  }

  const latest = events.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
  for (const event of latest) {
    const ts = event.ts.replace('T', ' ').slice(5, 16);
    dashboardLog(
      `  ${chalk.gray('•')} ${chalk.dim(ts)} ${chalk.white(event.decision.padEnd(30))} ${chalk.cyan((event.mission || 'system').slice(0, 32))}`
    );
    if (event.why) {
      dashboardLog(`    ${chalk.dim(event.why.slice(0, 96))}`);
    }
  }
  dashboardLog('');
}

function drawOwnerSummaries() {
  const slackMissionsPath = pathResolver.shared('observability/channels/slack/missions.jsonl');
  dashboardLog(chalk.bold.yellow(' 👑 OWNER SUMMARIES'));

  if (!safeExistsSync(slackMissionsPath)) {
    dashboardLog(chalk.dim('  (No owner summaries yet)'));
    dashboardLog('');
    return;
  }

  const summaries = readTextFile(slackMissionsPath)
    .split('\n')
    .filter(Boolean)
    .map(parseDashboardOwnerSummaryLine)
    .filter((event) => event !== undefined)
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 4);

  if (summaries.length === 0) {
    dashboardLog(chalk.dim('  (No owner summaries yet)'));
    dashboardLog('');
    return;
  }

  for (const summary of summaries) {
    dashboardLog(
      `  ${chalk.gray('•')} ${chalk.cyan(String(summary.mission_id || 'unknown').slice(0, 32))} ${chalk.dim(`accepted=${summary.accepted_count || 0} reviewed=${summary.reviewed_count || 0} completed=${summary.completed_count || 0} requested=${summary.requested_count || 0}`)}`
    );
  }
  dashboardLog('');
}

function drawRuntimeLeaseDoctor() {
  dashboardLog(chalk.bold.red(' 🩺 RUNTIME LEASE DOCTOR'));
  const findings = collectRuntimeDoctorFindings();

  if (findings.length === 0) {
    dashboardLog(chalk.dim('  (No runtime doctor findings)'));
    dashboardLog('');
    return;
  }

  for (const finding of findings) {
    const severity =
      finding.severity === 'critical' ? chalk.red('CRITICAL') : chalk.yellow('WARNING');
    dashboardLog(
      `  ${chalk.gray('•')} ${finding.agentId.padEnd(24)} [${severity}] ${chalk.dim(finding.reason)}`
    );
  }
  dashboardLog('');
}

function drawBackupStatus() {
  dashboardLog(chalk.bold.cyan(' 💾 BACKUP STATUS'));
  const status = summarizeBackupStatus();
  if (status.status === 'missing') {
    dashboardLog(chalk.yellow('  No backup archives found.'));
    dashboardLog(
      chalk.dim('  Run: KYBERION_BACKUP_PASSPHRASE=... pnpm backup create --scope all --encrypt')
    );
    dashboardLog('');
    return;
  }
  const color =
    status.status === 'fresh' ? chalk.green : status.status === 'stale' ? chalk.yellow : chalk.red;
  const age = status.latestAgeHours?.toFixed(1) ?? 'unknown';
  const sizeMb =
    status.latestSizeBytes === null ? 'unknown' : (status.latestSizeBytes / 1024 / 1024).toFixed(1);
  dashboardLog(`  Status: ${color(status.status.toUpperCase())}`);
  dashboardLog(
    `  Latest: ${chalk.white(status.latestName || 'unknown')} ${chalk.dim(`${age}h ago`)}`
  );
  dashboardLog(`  Archives: ${status.count} ${chalk.dim(`latest=${sizeMb}MB`)}`);
  dashboardLog(`  Dir: ${chalk.dim(status.backupDir)}`);
  dashboardLog('');
}

function drawSlackOutbox() {
  dashboardLog(chalk.bold.green(' 📬 SURFACE OUTBOX'));
  const slackMessages = listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true });
  const chronosMessages = listSurfaceOutboxMessages('chronos', { includeTenantNamespaces: true });
  dashboardLog(
    `  Slack pending:   ${slackMessages.length > 0 ? chalk.bold.yellow(slackMessages.length) : chalk.dim(0)}`
  );
  dashboardLog(
    `  Chronos pending: ${chronosMessages.length > 0 ? chalk.bold.yellow(chronosMessages.length) : chalk.dim(0)}`
  );
  for (const message of slackMessages.slice(0, 4)) {
    dashboardLog(
      `  ${chalk.gray('•')} ${chalk.cyan(`slack/${message.source}`.padEnd(14))} ${chalk.dim(message.channel)} ${chalk.white(message.text.slice(0, 64))}`
    );
  }
  for (const message of chronosMessages.slice(0, 2)) {
    dashboardLog(
      `  ${chalk.gray('•')} ${chalk.cyan(`chronos/${message.source}`.padEnd(14))} ${chalk.dim(message.channel)} ${chalk.white(message.text.slice(0, 64))}`
    );
  }
  dashboardLog('');
}

function drawA2ATraffic() {
  const inbox = pathResolver.rootResolve('active/shared/runtime/a2a/inbox');
  const outbox = pathResolver.rootResolve('active/shared/runtime/a2a/outbox');

  dashboardLog(chalk.bold.magenta(' 📡 A2A TRAFFIC'));

  const inCount = safeExistsSync(inbox) ? safeReaddir(inbox).length : 0;
  const outCount = safeExistsSync(outbox) ? safeReaddir(outbox).length : 0;

  dashboardLog(`  Inbox:  ${inCount > 0 ? chalk.bold.green(inCount) : chalk.dim(0)} pending`);
  dashboardLog(`  Outbox: ${outCount > 0 ? chalk.bold.yellow(outCount) : chalk.dim(0)} sending\n`);
}

function drawRuntimeSurfaces() {
  const statePath = pathResolver.shared('runtime/surfaces/state.json');
  const snapshotPath = pathResolver.knowledge('product/governance/active-surfaces.json');
  const surfacesDir = pathResolver.knowledge('product/governance/surfaces');

  dashboardLog(chalk.bold.blue(' 🛰️ RUNTIME SURFACES'));

  if (!safeExistsSync(snapshotPath) && !safeExistsSync(surfacesDir)) {
    dashboardLog(chalk.dim('  (Surface manifest not found)'));
    dashboardLog('');
    return;
  }
  const manifest = loadSurfaceManifest();
  const state = safeExistsSync(statePath)
    ? readJson<{ surfaces: Record<string, { pid: number }> }>(statePath)
    : { surfaces: {} };

  for (const surface of manifest.surfaces) {
    const record = state.surfaces?.[surface.id];
    const status = record?.pid
      ? chalk.green(renderStatus('runtime', 'running', 'en').toUpperCase())
      : chalk.dim(renderStatus('runtime', 'stopped', 'en').toUpperCase());
    const pid = record?.pid ? chalk.gray(` pid=${record.pid}`) : '';
    dashboardLog(
      `  ${chalk.gray('•')} ${surface.id.padEnd(20)} [${status}] ${chalk.dim(surface.kind)}${pid}`
    );
  }
  dashboardLog('');
}

function drawTrustBoard() {
  dashboardLog(chalk.bold.green(' 🤝 AGENT TRUST BOARD'));
  let ledger: ReturnType<typeof loadPersistedTrustLedger> = null;
  try {
    ledger = loadPersistedTrustLedger();
  } catch {
    ledger = null;
  }
  if (ledger) {
    Object.entries(ledger).forEach(([agentId, record]) => {
      const score = record.current_score / 100;
      const bar = '█'.repeat(Math.floor(score)) + '░'.repeat(10 - Math.floor(score));
      dashboardLog(`  ${agentId.padEnd(15)} [${chalk.cyan(bar)}] ${score.toFixed(1)}`);
    });
  } else {
    dashboardLog(chalk.dim('  (Trust ledger not found)'));
  }
  dashboardLog('');
}

function render(
  argv: string[] = [],
  options: { clear?: boolean; interactive?: boolean } = {}
): void {
  const focus = getDashboardFocus(argv);
  if (options.clear !== false) clearScreen();
  drawHeader();
  drawCompanyOverview();
  drawOnboardingHome();
  drawTenantContext();
  drawConnectionReview();
  drawStarterMissionSuggestion();
  if (focus === 'capabilities') {
    drawCapabilityLandscape();
    dashboardLog(chalk.dim(' Focused view: provider capability snapshot and provider health.'));
    dashboardLog(chalk.dim(' Press Ctrl+C to exit.'));
    return;
  }
  if (focus === 'skills') {
    drawSkillLandscape();
    dashboardLog(chalk.dim(' Focused view: governed skill catalog.'));
    dashboardLog(chalk.dim(' Press Ctrl+C to exit.'));
    return;
  }
  if (focus === 'onboarding') {
    dashboardLog(
      chalk.dim(
        ' Focused view: onboarding setup, connection review, tenant context, starter mission.'
      )
    );
    dashboardLog(chalk.dim(' Press Ctrl+C to exit.'));
    return;
  }
  drawMissions();
  drawMissionOrchestration();
  drawOwnerSummaries();
  drawRuntimeLeaseDoctor();
  drawBackupStatus();
  drawRuntimeSurfaces();
  drawCapabilityLandscape();
  drawSkillLandscape();
  drawSlackOutbox();
  drawA2ATraffic();
  drawTrustBoard();
  if (options.interactive !== false) {
    dashboardLog(chalk.dim(' Press Ctrl+C to exit. Refreshing every 5s...'));
  }
}

/**
 * Render one read-only dashboard snapshot through the shared script boundary.
 * The interactive ANSI view remains unchanged; JSON callers receive the same
 * snapshot as a single structured value instead of a stream of log lines.
 */
export function renderDashboardSnapshot(argv: string[] = []): {
  ok: true;
  focus: DashboardFocus;
  output: string;
} {
  const lines: string[] = [];
  const previousLog = dashboardLog;
  dashboardLog = (...values) => lines.push(values.map((value) => String(value)).join(' '));
  try {
    render(argv, { clear: false, interactive: false });
  } finally {
    dashboardLog = previousLog;
  }
  return { ok: true, focus: getDashboardFocus(argv), output: lines.join('\n') };
}

export function main(argv: string[] = []): void {
  if (argv.includes('--once')) {
    render(argv, { interactive: false });
  } else {
    render(argv);
    setInterval(() => render(argv), 5000);
  }
}

if (
  isDirectScript(import.meta.url, 'sovereign_dashboard.ts') ||
  isDirectScript(import.meta.url, 'sovereign_dashboard.js')
)
  void defineScript({
    name: 'dashboard',
    run: ({ argv, json, quiet, dryRun, check, print }) => {
      const bounded = json || quiet || dryRun || check || argv.includes('--once');
      if (json) {
        const snapshot = renderDashboardSnapshot(argv);
        print(snapshot);
        return snapshot;
      }
      if (quiet) {
        renderDashboardSnapshot(argv);
        return;
      }
      if (bounded) {
        render(argv, { interactive: false });
        return;
      }
      main(argv);
    },
  })();
