import { grantVoiceConsent, pathResolver, resolveVars, safeExecResult } from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import type { PipelineAdfStep } from '@agent/core/pipeline-contract';
import { applyOnboardingInput } from './onboarding_apply.js';
import { runCampaignSuite } from './campaign_suite.js';
import { runAiAudit } from './run_ai_audit.js';
import { main as runFirstWinLifecycle } from './first_win_lifecycle_smoke.js';
import { runDependencyVulnerabilityScanOnce } from './scan_dependency_vulns.js';
import { runHealthDegradationWatch } from './health_degradation_watch.js';
import { collectUiUxGovernanceReport } from './check_ui_ux_governance.js';
import { runTenantDriftWatch } from './watch_tenant_drift.js';
import { runAutoCheckpoint } from './auto_checkpoint.js';
import { createBackup, runRestoreDrill } from './backup.js';
import { generateSoftwareQualityArtifacts } from './software_quality_report.js';
import { runSoakEnduranceHarness } from './soak_endurance.js';
import { runSoakRestartE2E } from './soak_restart_e2e.js';
import { runMarketingVideoDryRun } from './marketing_video_dry_run.js';
import { runComplianceScan } from './compliance_checker.js';
import { runMeshDeliveryDriverOnce } from './mesh_delivery_driver.js';
import { main as promoteProcedure } from './promote_procedure.js';
import { checkI18nHardcoding } from './check_i18n_hardcoding.js';
import { runCatalogIntegrityCheck } from './check_catalog_integrity.js';
import {
  computeTranslationCoverageReport,
  runAlertOnRegression,
} from './report_i18n_translation_coverage.js';
import { runDocExamplesCheck } from './check_doc_examples.js';
import { main as manageRegistry } from './registry_manager.js';
import { main as missionController } from './mission_controller.js';
import { runCapturePhoto } from './capture_photo.js';
import { runGenerateAvatar } from './generate_avatar.js';
import { runRegisterAvatar } from './register_avatar.js';
import { runOAuthSetupForService } from './setup_oauth.js';

function sourceValue(params: Record<string, unknown>, ctx: Record<string, unknown>): unknown {
  const source = typeof params.source === 'string' ? params.source : '';
  return source ? ctx[source] : resolveVars(params.input ?? ctx, ctx);
}

function exportValue(
  params: Record<string, unknown>,
  step: PipelineAdfStep,
  value: unknown,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const key =
    typeof params.export_as === 'string' && params.export_as
      ? params.export_as
      : typeof step.produces === 'string'
        ? step.produces
        : step.produces?.channel || 'last_transform';
  return { ...ctx, [key]: value };
}

function parseJsonPayload(raw: unknown, label: string): Record<string, unknown> {
  if (!raw) throw new Error(`${label} is missing from context`);
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const externalTag = ['untrusted', 'external'].join('-');
  const wrapped = text.match(
    new RegExp(`<${externalTag}[^>]*>\\s*([\\s\\S]*?)\\s*</${externalTag}>`, 'i')
  );
  const unwrapped = wrapped ? wrapped[1] : text;
  const fenced = unwrapped.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const parsed = JSON.parse((fenced ? fenced[1] : unwrapped).trim()) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must decode to an object`);
  }
  return parsed as Record<string, unknown>;
}

export function runInlineProposalBriefParse(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const parsed = parseJsonPayload(sourceValue(params, ctx), 'deck_brief_raw');
  return exportValue(
    params,
    step,
    {
      ...parsed,
      kind: 'proposal-brief',
      tenant_id: ctx.tenant_slug || parsed.tenant_slug,
    },
    ctx
  );
}

export function runInlineProductivityDryRunValidation(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const plan = parseJsonPayload(sourceValue(params, ctx), 'task_plan_raw');
  if (plan.kind !== 'productivity-task-plan') {
    throw new Error('invalid productivity task plan kind');
  }
  if (
    (plan.execution as Record<string, unknown> | undefined)?.mode !== 'dry_run' ||
    (plan.execution as Record<string, unknown> | undefined)?.external_effects_executed !== false
  ) {
    throw new Error('productivity task plan must be dry-run only');
  }
  if (
    !Array.isArray(plan.steps) ||
    plan.steps.some((item) => (item as Record<string, unknown>)?.execution_mode !== 'preview_only')
  ) {
    throw new Error('all productivity steps must remain preview_only');
  }
  const approval = plan.approval as Record<string, unknown> | undefined;
  return exportValue(
    params,
    step,
    {
      kind: 'productivity-review-package',
      mission_id: ctx.mission_id,
      status: approval?.required ? 'approval_required' : 'ready_for_local_draft',
      request: plan.request,
      domains: plan.domains,
      steps: plan.steps,
      approval: plan.approval,
      missing_inputs: plan.missing_inputs,
      evidence_plan: plan.evidence_plan,
      external_effects_executed: false,
    },
    ctx
  );
}

/** Compute the deterministic productivity score without a child shell. */
export function runInlineProductivityScore(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const metric = (key: string): number => {
    const raw = resolveVars(params[key] ?? ctx[key], ctx);
    const candidate =
      raw && typeof raw === 'object'
        ? ((raw as Record<string, unknown>).stdout ??
          (raw as Record<string, unknown>).output ??
          (raw as Record<string, unknown>).value ??
          (raw as Record<string, unknown>).result ??
          raw)
        : raw;
    const match = String(candidate ?? '')
      .trim()
      .match(/-?\d+/u);
    const value = match ? Number.parseInt(match[0], 10) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error(
        `productivity metric ${key} must be an integer (received ${JSON.stringify(raw)})`
      );
    }
    return value;
  };
  const tsFiles = metric('ts_file_count');
  const testFiles = metric('test_file_count');
  const fixmeCount = metric('fixme_count');
  const score = tsFiles > 0 ? Math.round((testFiles / tsFiles) * 100 - fixmeCount) : 0;
  return exportValue(params, step, score, ctx);
}

export function runInlineVoiceConsentGrant(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const missionId = String(resolveVars(params.mission_id ?? ctx.mission_id, ctx) || '').trim();
  const operator = String(
    resolveVars(params.operator ?? ctx.operator_handle ?? 'operator', ctx)
  ).trim();
  if (!missionId) throw new Error('voice consent grant requires mission_id');
  if (!operator) throw new Error('voice consent grant requires operator');
  const record = grantVoiceConsent({
    missionId,
    operator,
    scope: String(resolveVars(params.scope ?? '', ctx)).trim() || undefined,
    note: String(resolveVars(params.note ?? '', ctx)).trim() || undefined,
    force: Boolean(resolveVars(params.force ?? false, ctx)),
    expiresAt: String(resolveVars(params.expires_at ?? '', ctx)).trim() || undefined,
  });
  return exportValue(params, step, { status: 'succeeded', ...record }, ctx);
}

/** Run an explicitly enumerated Vitest suite without a pipeline shell wrapper. */
export function runInlineVitest(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const rawFiles = resolveVars(params.files ?? [], ctx);
  if (
    !Array.isArray(rawFiles) ||
    rawFiles.length === 0 ||
    rawFiles.some((file) => typeof file !== 'string' || !file.trim())
  ) {
    throw new Error('core:run_vitest requires a non-empty params.files string array');
  }
  const files = rawFiles.map((file) => String(file).trim());
  const workingDir = pathResolver.rootResolve(String(resolveVars(params.working_dir ?? '.', ctx)));
  const timeoutMs = Math.max(
    1_000,
    Number(resolveVars(params.timeout_ms ?? 120_000, ctx)) || 120_000
  );
  const testTimeoutMs = Number(resolveVars(params.test_timeout_ms ?? 0, ctx));
  const args = ['exec', 'vitest', 'run', ...files];
  if (Number.isFinite(testTimeoutMs) && testTimeoutMs > 0)
    args.push(`--testTimeout=${Math.floor(testTimeoutMs)}`);
  const result = safeExecResult('pnpm', args, {
    cwd: workingDir,
    timeoutMs,
    maxOutputMB: 20,
  });
  const envelope = {
    status: result.status === 0 ? 'succeeded' : 'failed',
    command: 'pnpm',
    args,
    working_dir: workingDir,
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.status !== 0) {
    throw new Error(
      `core:run_vitest failed (exit=${String(result.status)}): ${result.stderr || result.stdout}`
    );
  }
  return exportValue(params, step, envelope, ctx);
}

export async function runInlineOnboardingApply(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const raw = resolveVars(params.input ?? ctx.onboarding_input ?? ctx, ctx);
  const input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const result = await applyOnboardingInput(input as any);
  return exportValue(params, step, result, ctx);
}

export function runInlineCampaignSuite(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const briefPath = String(resolveVars(params.brief_path ?? ctx.brief_path ?? '', ctx)).trim();
  if (!briefPath) throw new Error('core:run_campaign_suite requires brief_path');
  const outputRoot =
    String(resolveVars(params.output_root ?? ctx.output_root ?? '', ctx)).trim() || undefined;
  const dryRunValue = resolveVars(params.dry_run ?? ctx.dry_run ?? false, ctx);
  const manifest = runCampaignSuite({
    briefPath,
    ...(outputRoot ? { outputRoot } : {}),
    dryRun: dryRunValue === true || String(dryRunValue).toLowerCase() === 'true',
  });
  return exportValue(params, step, manifest, ctx);
}

export async function runInlineAiAudit(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await runAiAudit({
    ...(params.invariants_dir
      ? { invariantsDir: String(resolveVars(params.invariants_dir, ctx)) }
      : {}),
    ...(params.output_dir ? { outputDir: String(resolveVars(params.output_dir, ctx)) } : {}),
    ...(params.concurrency ? { concurrency: Number(resolveVars(params.concurrency, ctx)) } : {}),
    ...(params.include_self_test_fixtures
      ? { includeSelfTestFixtures: Boolean(resolveVars(params.include_self_test_fixtures, ctx)) }
      : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`core:run_ai_audit failed (exit=${result.exitCode})`);
  }
  return exportValue(params, step, result.report, ctx);
}

export function runInlineFirstWinLifecycle(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const report = runFirstWinLifecycle(['--dry-run']);
  if (report.status !== 'passed') throw new Error('core:run_first_win_lifecycle failed');
  return exportValue(params, step, report, ctx);
}

export async function runInlineDependencyVulnerabilityScan(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const report = await runDependencyVulnerabilityScanOnce();
  return exportValue(params, step, report, ctx);
}

export function runInlineHealthDegradationWatch(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const result = runHealthDegradationWatch();
  return exportValue(params, step, { ...result.report, alert_id: result.alert?.id ?? null }, ctx);
}

export function runInlineUiUxGovernanceAudit(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const report = collectUiUxGovernanceReport();
  if (report.status === 'fail')
    throw new Error(`core:run_ui_ux_governance failed (${report.violations.length} violations)`);
  return exportValue(params, step, report, ctx);
}

export function runInlineTenantDriftWatch(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const result = runTenantDriftWatch({ alert: true });
  if (result.status !== 0)
    throw new Error(
      `core:run_tenant_drift_watch failed (${result.report.findings.length} findings)`
    );
  return exportValue(params, step, { ...result.report, alert_id: result.alert?.id ?? null }, ctx);
}

export async function runInlineAutoCheckpoint(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const status = await runAutoCheckpoint();
  if (status !== 0) throw new Error(`core:run_auto_checkpoint failed (exit=${status})`);
  return exportValue(params, step, { status: 'succeeded' }, ctx);
}

export function runInlineBackupCreate(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const result = createBackup({
    command: 'create',
    scope: 'all',
    encrypt: true,
    prune: true,
    retainDaily: 7,
    retainWeekly: 4,
    passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
  });
  return exportValue(
    params,
    step,
    { ok: true, archive: result.archive, entries: result.plan.entries },
    ctx
  );
}

export function runInlineBackupRestoreDrill(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const result = runRestoreDrill({
    command: 'drill',
    scope: 'all',
    backupDir: String(resolveVars(params.backup_dir ?? ctx.backup_dir ?? '', ctx)) || undefined,
    target:
      String(resolveVars(params.restore_target ?? ctx.restore_target ?? '', ctx)) || undefined,
    prepareCheckout: true,
    force: true,
    passphraseEnv: 'KYBERION_BACKUP_PASSPHRASE',
    retainDaily: 7,
    retainWeekly: 4,
  });
  return exportValue(params, step, { ok: true, ...result }, ctx);
}

export function runInlineSoftwareQualityReport(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  const result = generateSoftwareQualityArtifacts({
    contractPath: value('contract_path'),
    inventoryPath: value('inventory_path'),
    executionPath: value('execution_path'),
    outputPath: value('report_path'),
    defectsPath: value('defects_path') || undefined,
    publishSummaryPath: value('operator_summary_path') || undefined,
    requiredRiskRefs: value('required_risk_refs')
      ? value('required_risk_refs')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
  });
  return exportValue(params, step, result, ctx);
}

export async function runInlineSoakEndurance(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const mode =
    String(resolveVars(params.mode ?? 'compressed', ctx)) === 'live' ? 'live' : 'compressed';
  const report = await runSoakEnduranceHarness({
    cycles: Number(resolveVars(params.cycles ?? 8, ctx)),
    mode,
    failOnRegression: true,
    quiet: true,
  });
  const validation =
    report.resource_regressions.length === 0 && report.latency_regressions.length === 0;
  if (!validation) throw new Error('core:run_soak_endurance detected regression');
  return exportValue(params, step, report, ctx);
}

export async function runInlineSoakRestartE2E(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const report = await runSoakRestartE2E(String(resolveVars(params.root ?? '', ctx)) || undefined);
  if (!report.restored) throw new Error('core:run_soak_restart_e2e did not restore state');
  return exportValue(params, step, report, ctx);
}

export function runInlineMarketingVideoDryRun(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  const result = runMarketingVideoDryRun({
    campaignBriefPath: value('campaign_brief'),
    brandProfilePath: value('brand_profile'),
    outputRoot: value('output_root'),
    channel: value('channel'),
    riskLevel: Number(value('risk_level') || 0),
  });
  return exportValue(params, step, result, ctx);
}

export async function runInlineComplianceScan(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const dir = String(resolveVars(params.target_dir ?? ctx.target_dir ?? '', ctx));
  const tier = String(resolveVars(params.target_tier ?? ctx.target_tier ?? 'public', ctx));
  const result = await runComplianceScan(['--dir', dir, '--tier', tier]);
  return exportValue(params, step, result, ctx);
}

export async function runInlineMeshDelivery(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const senderPeerId =
    String(resolveVars(params.sender_peer_id ?? '', ctx)).trim() ||
    String(getRegisteredEnvText('KYBERION_MESH_PEER_ID') || '').trim();
  if (!senderPeerId) throw new Error('core:run_mesh_delivery requires sender_peer_id');
  const report = await runMeshDeliveryDriverOnce({
    senderPeerId,
    sharedSecret:
      String(resolveVars(params.shared_secret ?? '', ctx)).trim() ||
      getRegisteredEnvText('KYBERION_MESH_SHARED_SECRET') ||
      undefined,
    batchLimit: Number(resolveVars(params.limit ?? 10, ctx)) || 10,
    json: false,
  });
  return exportValue(params, step, report, ctx);
}

export function runInlinePromoteProcedure(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  promoteProcedure([
    '--recording',
    value('recording_ref'),
    '--procedure-id',
    value('procedure_id'),
    '--intent-phrases',
    value('intent_phrases'),
    '--status',
    value('status') || 'active',
  ]);
  return exportValue(params, step, { status: 'succeeded' }, ctx);
}

export function runInlineI18nHardcoding(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const report = checkI18nHardcoding({ updateBaseline: false });
  return exportValue(params, step, report, ctx);
}

export function runInlineCatalogIntegrity(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  try {
    return exportValue(params, step, runCatalogIntegrityCheck(), ctx);
  } catch (error) {
    return exportValue(
      params,
      step,
      { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      ctx
    );
  }
}

export function runInlineTranslationCoverage(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const report = computeTranslationCoverageReport();
  const regressions = runAlertOnRegression(report);
  return exportValue(params, step, { ...report, regressions }, ctx);
}

export function runInlineDocExamplesCheck(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  return exportValue(params, step, runDocExamplesCheck(), ctx);
}

export async function runInlineRegistryManager(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const adapter = String(resolveVars(params.adapter ?? '', ctx)).trim();
  const tier = String(resolveVars(params.tier ?? 'public', ctx)).trim();
  const type = String(resolveVars(params.type ?? '', ctx)).trim();
  if (!adapter || !type) throw new Error('core:run_registry_manager requires adapter and type');
  await manageRegistry(['--adapter', adapter, '--tier', tier, '--type', type]);
  return exportValue(params, step, { status: 'succeeded', adapter, tier, type }, ctx);
}

export async function runInlineMissionCreate(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  const missionId = value('mission_id');
  const args = missionId
    ? [
        'create',
        missionId,
        value('tier'),
        value('tenant_id'),
        value('mission_type'),
        value('vision_ref'),
        value('persona'),
        JSON.stringify({ prerequisites: params.prerequisites ?? [] }),
      ]
    : [
        'create',
        value('tier'),
        value('tenant_id'),
        value('mission_type'),
        value('vision_ref'),
        value('persona'),
      ];
  await missionController(args);
  return exportValue(params, step, { status: 'succeeded' }, ctx);
}

export async function runInlineMissionStartFromIssues(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const raw = resolveVars(params.issues ?? ctx.parsed_issues ?? [], ctx);
  const candidate =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).stdout ?? (raw as Record<string, unknown>).output ?? raw)
      : raw;
  const issues = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
  if (!Array.isArray(issues))
    throw new Error('core:run_mission_start_from_issues requires an array');
  const started: string[] = [];
  for (const issue of issues) {
    const title = String((issue as Record<string, unknown>)?.title ?? '').trim();
    if (!title) continue;
    await missionController(['start', title, 'personal']);
    started.push(title);
  }
  return exportValue(params, step, { status: 'succeeded', started }, ctx);
}

export async function runInlineCaptureAvatarPhoto(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const output = String(
    resolveVars(params.output_path ?? ctx.capture_output_path ?? '', ctx)
  ).trim();
  if (!output) throw new Error('core:capture_avatar_photo requires output_path');
  await runCapturePhoto([output]);
  return exportValue(params, step, { status: 'succeeded', output_path: output }, ctx);
}

export async function runInlineGenerateAvatar(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  await runGenerateAvatar([
    '--input-photo',
    value('input_photo'),
    '--output-path',
    value('output_path'),
    '--prompt',
    value('prompt'),
    '--bridge-preference',
    value('bridge_preference') || 'auto',
  ]);
  return exportValue(params, step, { status: 'succeeded', output_path: value('output_path') }, ctx);
}

export async function runInlineRegisterAvatar(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const value = (key: string): string =>
    String(resolveVars(params[key] ?? ctx[key] ?? '', ctx)).trim();
  await runRegisterAvatar([
    '--src-avatar',
    value('src_avatar'),
    '--dest-avatar',
    value('dest_avatar'),
    '--identity-path',
    value('identity_path'),
    '--avatar-path',
    value('avatar_path'),
    '--profile-name',
    value('profile_name'),
    '--language',
    value('language'),
    '--interaction-style',
    value('interaction_style'),
  ]);
  return exportValue(params, step, { status: 'succeeded', avatar_path: value('dest_avatar') }, ctx);
}

export async function runInlineOAuthSetup(
  step: PipelineAdfStep,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const service = String(resolveVars(params.service_name ?? ctx.service_name ?? '', ctx)).trim();
  if (!service) throw new Error('core:run_oauth_setup requires service_name');
  await runOAuthSetupForService(service);
  return exportValue(params, step, { status: 'succeeded', service_id: service }, ctx);
}
