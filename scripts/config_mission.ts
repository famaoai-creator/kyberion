/**
 * scripts/config_mission.ts
 * Config Mission CLI — governed self-extension for Kyberion
 * [SECURE-IO COMPLIANT]
 *
 * Commands:
 *   list                              — show available presets
 *   create --preset <id> --tenant <slug> [--input key=value ...]
 *                                     — instantiate a preset into a tenant namespace
 *   status --tenant <slug> [--id <cfg-id>]
 *                                     — show config mission status
 *   apply  --tenant <slug> --id <cfg-id>
 *                                     — execute the config mission pipeline
 */

import * as nodePath from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { auditChain } from '@agent/core/audit-chain';
import {
  assertConfigChangeApplyable,
  computeConfigChangeFingerprint,
  configChangeRequiresApproval,
  normalizeConfigChangeEnvelope,
} from '@agent/core/config-change';
import {
  createApprovalRequest,
  loadApprovalRequest,
  recordApprovalApplyResult,
} from '@agent/core/approval-store';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import {
  loadConfigMissionBriefAtPath,
  loadConfigMissionPresetAtPath,
  type ConfigMissionBrief,
  type ConfigMissionPreset,
} from '@agent/core/config-mission';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import * as pathResolver from '@agent/core/path-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Print = (value: unknown) => void;

let activePrint: Print = () => undefined;

function printText(value: unknown = ''): void {
  activePrint(value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PRESET_DIR = 'knowledge/product/config-missions';

function requirePathSegment(value: string, label: string): string {
  const segment = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(segment) || segment.startsWith('.')) {
    throw new Error(`[config-mission] invalid ${label}: ${value}`);
  }
  return segment;
}

function configMissionRoot(tenant: string): string {
  if (!isValidTenantSlug(tenant)) {
    throw new Error(`[config-mission] invalid tenant slug: ${tenant}`);
  }
  return assertSafeRepositoryPath(
    nodePath.join('knowledge', 'confidential', tenant, 'config-missions'),
    { allowMissingLeaf: true }
  );
}

export function resolveConfigMissionBriefPath(tenant: string, instanceId: string): string {
  return assertSafeRepositoryPath(
    nodePath.join(
      configMissionRoot(tenant),
      requirePathSegment(instanceId, 'instance id'),
      'brief.json'
    ),
    {
      allowMissingLeaf: true,
    }
  );
}

function briefPath(tenant: string, instanceId: string): string {
  return resolveConfigMissionBriefPath(tenant, instanceId);
}

function instanceDir(tenant: string, instanceId: string): string {
  return assertSafeRepositoryPath(
    nodePath.join(configMissionRoot(tenant), requirePathSegment(instanceId, 'instance id')),
    {
      allowMissingLeaf: true,
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPreset(presetId: string): ConfigMissionPreset {
  const p = assertSafeRepositoryPath(
    nodePath.join(PRESET_DIR, `${requirePathSegment(presetId, 'preset id')}.json`)
  );
  if (!safeLstat(p).isFile()) {
    throw new Error(`[config-mission] preset must be a regular file: ${p}`);
  }
  return loadConfigMissionPresetAtPath(p);
}

function requireBriefFile(filePath: string): string {
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[config-mission] brief must be a regular file: ${filePath}`);
  }
  return filePath;
}

function listPresets(): ConfigMissionPreset[] {
  const presetDir = assertSafeRepositoryPath(PRESET_DIR);
  const entries = safeReaddir(presetDir) as string[];
  return entries
    .filter((f) => {
      if (!f.endsWith('.json')) return false;
      try {
        return safeLstat(assertSafeRepositoryPath(nodePath.join(presetDir, f))).isFile();
      } catch {
        return false;
      }
    })
    .map((f) => {
      try {
        return loadPreset(f.replace('.json', ''));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ConfigMissionPreset[];
}

function parseInputArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) throw new Error(`Invalid --input format: "${arg}". Expected key=value`);
    result[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
  }
  return result;
}

function parseProbeRefs(args: string[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx <= 0) throw new Error(`Invalid --probe-ref format: "${arg}". Expected key=value`);
    refs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
  }
  return refs;
}

function getOption(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function getMultiOption(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) values.push(argv[++i]);
  }
  return values;
}

function targetKindFor(
  preset: ConfigMissionPreset,
  value: string | undefined
): import('@agent/core/config-change').ConfigChangeTargetKind {
  const targetKind = value || preset.target_kind || 'tenant';
  const allowed = new Set([
    'system',
    'tenant',
    'organization',
    'project',
    'mission',
    'task',
    'surface',
    'channel',
    'personal',
  ]);
  if (!allowed.has(targetKind)) throw new Error(`Invalid --target-kind: ${targetKind}`);
  return targetKind as import('@agent/core/config-change').ConfigChangeTargetKind;
}

function scopeKindFor(
  preset: ConfigMissionPreset,
  targetKind: import('@agent/core/config-change').ConfigChangeTargetKind
): 'system' | 'tenant' | 'organization' | 'project' | 'mission' | 'task' {
  if (preset.scope_kind) return preset.scope_kind;
  if (targetKind === 'system') return 'system';
  if (
    targetKind === 'organization' ||
    targetKind === 'project' ||
    targetKind === 'mission' ||
    targetKind === 'task'
  ) {
    return targetKind;
  }
  return 'tenant';
}

function tierFor(
  preset: ConfigMissionPreset,
  scopeKind: string
): 'public' | 'confidential' | 'personal' {
  return preset.tier || (scopeKind === 'system' ? 'public' : 'confidential');
}

function riskFor(
  preset: ConfigMissionPreset
): import('@agent/core/config-change').ConfigChangeRisk {
  if (
    preset.category === 'security' ||
    preset.category === 'surface' ||
    preset.category === 'service_integration'
  )
    return 'high';
  if (preset.category === 'tenant') return 'high';
  return 'medium';
}

function generateInstanceId(): string {
  return `cfg-${Date.now()}`;
}

function validateInputs(preset: ConfigMissionPreset, inputs: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [key, def] of Object.entries(preset.inputs)) {
    const val = inputs[key];
    if (def.required !== false && !val && def.default === undefined) {
      errors.push(`Missing required input: ${key} — ${def.description}`);
    }
    if (def.type === 'enum' && val && def.values && !def.values.includes(val)) {
      errors.push(`Invalid value for ${key}: "${val}". Allowed: ${def.values.join(', ')}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(): void {
  const presets = listPresets();
  if (presets.length === 0) {
    printText('No config mission presets found.');
    return;
  }
  printText('\nAvailable config mission presets:\n');
  printText('  PRESET ID                        CATEGORY             DESCRIPTION');
  printText('  ' + '─'.repeat(80));
  for (const p of presets) {
    const id = p.preset_id.padEnd(32);
    const cat = p.category.padEnd(20);
    printText(`  ${id} ${cat} ${p.description}`);
  }
  printText(`\nTotal: ${presets.length} preset(s)`);
  printText(
    `\nTo create a mission: pnpm config-mission create --preset <id> --tenant <slug> [--input key=value ...]`
  );
}

function cmdCreate(argv: string[]): void {
  const presetId = getOption(argv, '--preset');
  const tenant = getOption(argv, '--tenant');
  if (!presetId) throw new Error('--preset is required');
  if (!tenant) throw new Error('--tenant is required');

  const preset = loadPreset(presetId);
  const inputs = parseInputArgs(getMultiOption(argv, '--input'));

  // Apply defaults
  for (const [key, def] of Object.entries(preset.inputs)) {
    if (!(key in inputs) && def.default !== undefined) {
      inputs[key] = String(def.default);
    }
  }
  inputs.tenant = tenant;

  const errors = validateInputs(preset, inputs);
  if (errors.length > 0) {
    printText('\n❌ Input validation failed:\n');
    for (const e of errors) printText(`  • ${e}`);
    throw new ScriptExitError(1, 'Input validation failed');
  }

  const instanceId = generateInstanceId();
  inputs.instance_id = instanceId;

  const targetKind = targetKindFor(preset, getOption(argv, '--target-kind'));
  const risk = riskFor(preset);
  const scopeKind = scopeKindFor(preset, targetKind);
  const tier = tierFor(preset, scopeKind);
  const scopeInput = {
    scope_kind: scopeKind,
    tier,
    ...(scopeKind === 'system' ? {} : { tenant_slug: tenant }),
    organization_id: getOption(argv, '--organization-id'),
    project_id: getOption(argv, '--project-id'),
    mission_id: getOption(argv, '--mission-id'),
    task_id: getOption(argv, '--task-id'),
    nhi_id: getOption(argv, '--nhi-id'),
  };
  const scope = normalizeConfigChangeEnvelope({
    change_id: instanceId,
    scope: scopeInput,
    target_kind: targetKind,
    requested_by:
      getOption(argv, '--requested-by') || getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
    nhi_id: getOption(argv, '--nhi-id'),
    risk,
    before_hash: getOption(argv, '--before-hash'),
    desired_hash: computeConfigChangeFingerprint({
      preset_id: presetId,
      target_kind: targetKind,
      scope: scopeInput,
      inputs,
      write_targets: preset.write_targets,
    }),
    approval_ref: getOption(argv, '--approval-ref'),
    probe_refs: parseProbeRefs(getMultiOption(argv, '--probe-ref')),
    rollback_ref: getOption(argv, '--rollback-ref'),
  });

  const brief: ConfigMissionBrief = {
    instance_id: instanceId,
    preset_id: presetId,
    tenant,
    inputs,
    status: 'draft',
    created_at: nowIso(),
    change: scope,
  };

  const dir = instanceDir(tenant, instanceId);
  safeMkdir(dir, { recursive: true });
  safeWriteFile(briefPath(tenant, instanceId), JSON.stringify(brief, null, 2));

  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'worker',
    action: 'config_mission.create',
    operation: `${presetId}/${instanceId}`,
    result: 'completed',
    metadata: { preset_id: presetId, tenant, instance_id: instanceId },
  });

  printText(`\n✅ Config mission created: ${instanceId}`);
  printText(`   Preset:  ${presetId}`);
  printText(`   Tenant:  ${tenant}`);
  printText(`   Brief:   ${briefPath(tenant, instanceId)}`);
  printText(`   Scope:   ${scope.scope.scope_kind}/${scope.scope.tenant_slug}`);
  printText(
    `   Risk:    ${scope.risk} (approval required: ${configChangeRequiresApproval(scope)})`
  );
  printText(`   Desired: ${scope.desired_hash}`);
  if (configChangeRequiresApproval(scope) && !scope.approval_ref) {
    printText(`\nNext: pnpm config-mission request-approval --tenant ${tenant} --id ${instanceId}`);
  }
  printText(`\nTo apply: pnpm config-mission apply --tenant ${tenant} --id ${instanceId}`);
}

function cmdRequestApproval(argv: string[]): void {
  const tenant = getOption(argv, '--tenant');
  const id = getOption(argv, '--id');
  if (!tenant) throw new Error('--tenant is required');
  if (!id) throw new Error('--id is required');
  const bPath = briefPath(tenant, id);
  if (!safeExistsSync(bPath)) throw new Error(`Config mission not found: ${bPath}`);
  const brief = loadConfigMissionBriefAtPath(requireBriefFile(bPath));
  const existing = brief.change.approval_ref
    ? loadApprovalRequest('config-mission', brief.change.approval_ref)
    : null;
  if (existing) {
    printText(`Approval already requested: ${existing.id}`);
    return;
  }
  const record = createApprovalRequest('mission_controller', {
    channel: 'config-mission',
    storageChannel: 'config-mission',
    threadTs: id,
    correlationId: `config-mission-${id}`,
    requestedBy: brief.change.requested_by,
    draft: {
      title: `Configuration change: ${brief.preset_id}`,
      summary: `Apply ${brief.preset_id} for tenant ${tenant}`,
      details: `Desired configuration fingerprint: ${brief.change.desired_hash}`,
      severity: brief.change.risk === 'critical' ? 'high' : brief.change.risk,
    },
    requestedByContext: {
      surface: 'api',
      actorId: brief.change.requested_by,
      actorRole: 'system_configurator',
      runtimeId: id,
    },
    accountability: { finalDecision: 'human_only', payloadHash: brief.change.desired_hash },
    scope: brief.change.scope,
  });
  brief.change.approval_ref = record.id;
  safeWriteFile(bPath, JSON.stringify(brief, null, 2));
  printText(`Approval requested: ${record.id}`);
  printText('Approve it through an existing governed approval surface before apply.');
}

function cmdStatus(argv: string[]): void {
  const getOpt = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const tenant = getOpt('--tenant');
  const id = getOpt('--id');
  if (!tenant) throw new Error('--tenant is required');

  const missionsDir = configMissionRoot(tenant);
  if (!safeExistsSync(missionsDir)) {
    printText(`No config missions found for tenant: ${tenant}`);
    return;
  }

  const entries = (safeReaddir(missionsDir) as string[]).filter((e) => e.startsWith('cfg-'));
  const targets = id ? entries.filter((e) => e === id) : entries;

  if (targets.length === 0) {
    printText(
      id
        ? `Config mission ${id} not found for tenant ${tenant}`
        : `No config missions for tenant ${tenant}`
    );
    return;
  }

  printText(`\nConfig missions for tenant '${tenant}':\n`);
  printText('  ID                         PRESET                           STATUS     CREATED');
  printText('  ' + '─'.repeat(85));

  for (const entry of targets) {
    try {
      const brief = loadConfigMissionBriefAtPath(requireBriefFile(briefPath(tenant, entry)));
      const instanceCol = brief.instance_id.padEnd(26);
      const presetCol = brief.preset_id.padEnd(32);
      const statusCol = brief.status.padEnd(10);
      const created = brief.created_at.slice(0, 10);
      printText(`  ${instanceCol} ${presetCol} ${statusCol} ${created}`);
    } catch {
      printText(`  ${entry.padEnd(26)} (unreadable brief)`);
    }
  }
}

async function cmdApply(argv: string[]): Promise<void> {
  const tenant = getOption(argv, '--tenant');
  const id = getOption(argv, '--id');
  if (!tenant) throw new Error('--tenant is required');
  if (!id) throw new Error('--id is required');

  const bPath = briefPath(tenant, id);
  if (!safeExistsSync(bPath)) throw new Error(`Config mission not found: ${bPath}`);

  const brief = loadConfigMissionBriefAtPath(requireBriefFile(bPath));

  const approval = brief.change.approval_ref
    ? loadApprovalRequest('config-mission', brief.change.approval_ref)
    : undefined;
  assertConfigChangeApplyable({
    envelope: normalizeConfigChangeEnvelope(brief.change),
    approval: approval
      ? {
          status: approval.status,
          payloadHash: approval.accountability?.payloadHash,
          scope: approval.scope,
        }
      : undefined,
  });

  if (brief.status === 'applied') {
    printText(`Config mission ${id} is already applied.`);
    return;
  }

  const preset = loadPreset(brief.preset_id);

  // Update status → applying
  brief.status = 'applying';
  safeWriteFile(bPath, JSON.stringify(brief, null, 2));

  printText(`[CONFIG_MISSION] Applying ${brief.preset_id} for tenant ${tenant}…`);

  try {
    // Delegate execution directly to Node.  The previous implementation used
    // `sh -c`, which is unavailable on a stock Windows installation and also
    // made environment values vulnerable to shell quoting differences.
    const pipelinePath = preset.pipeline;
    const inputEnv = Object.fromEntries(
      Object.entries(brief.inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, String(v)])
    );
    safeExec('node', ['dist/scripts/run_pipeline.js', '--input', pipelinePath], {
      cwd: pathResolver.rootDir(),
      env: {
        KYBERION_PERSONA: 'worker',
        SYSTEM_ROLE: 'system_configurator',
        ...inputEnv,
      },
    });

    brief.status = 'applied';
    brief.applied_at = nowIso();
    safeWriteFile(bPath, JSON.stringify(brief, null, 2));

    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'worker',
      action: 'config_mission.apply',
      operation: `${brief.preset_id}/${id}`,
      result: 'completed',
      metadata: { preset_id: brief.preset_id, tenant, instance_id: id },
    });

    if (approval) {
      recordApprovalApplyResult('mission_controller', {
        channel: 'config-mission',
        storageChannel: 'config-mission',
        requestId: approval.id,
        applyResult: {
          appliedAt: brief.applied_at,
          appliedBy: 'config_mission',
          result: 'success',
        },
      });
    }

    printText(`\n✅ Config mission ${id} applied successfully.`);
    if (preset.notes) printText(`\n💡 ${preset.notes}`);
  } catch (err) {
    brief.status = 'failed';
    brief.error = String(err);
    safeWriteFile(bPath, JSON.stringify(brief, null, 2));

    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'worker',
      action: 'config_mission.apply',
      operation: `${brief.preset_id}/${id}`,
      result: 'failed',
      metadata: { preset_id: brief.preset_id, tenant, instance_id: id, error: String(err) },
    });

    if (approval) {
      recordApprovalApplyResult('mission_controller', {
        channel: 'config-mission',
        storageChannel: 'config-mission',
        requestId: approval.id,
        applyResult: {
          appliedAt: nowIso(),
          appliedBy: 'config_mission',
          result: 'failed',
          auditRef: String(err),
        },
      });
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  printText('Usage: pnpm config-mission <list|create|status|request-approval|apply> [options]');
  printText('  pnpm config-mission help');
  printText('  pnpm config-mission create --preset <id> --tenant <slug> [--input key=value ...]');
  printText('  pnpm config-mission status --tenant <slug> [--id <cfg-id>]');
  printText('  pnpm config-mission request-approval --tenant <slug> --id <cfg-id>');
  printText('  pnpm config-mission apply --tenant <slug> --id <cfg-id>');
}

async function mainImpl(args: string[] = []): Promise<void> {
  const [command, ...rest] = args;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    if (!command) throw new ScriptExitError(2);
    return;
  }

  switch (command) {
    case 'list':
      cmdList();
      break;
    case 'create':
      cmdCreate(rest);
      break;
    case 'status':
      cmdStatus(rest);
      break;
    case 'request-approval':
      cmdRequestApproval(rest);
      break;
    case 'apply':
      await cmdApply(rest);
      break;
    default:
      printText(`Unknown command: ${command ?? '(none)'}`);
      printUsage();
      throw new ScriptExitError(1, `Unknown command: ${command ?? '(none)'}`);
  }
}

export async function main(args: string[] = [], print: Print = () => undefined): Promise<void> {
  const previousPrint = activePrint;
  activePrint = print;
  try {
    await mainImpl(args);
  } finally {
    activePrint = previousPrint;
  }
}

const script = defineScript({
  name: 'config:mission',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'config_mission.ts') ||
  isDirectScript(import.meta.url, 'config_mission.js')
) {
  void script();
}
