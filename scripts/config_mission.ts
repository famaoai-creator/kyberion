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
  logger,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  auditChain,
} from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PresetInput {
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required?: boolean;
  values?: string[];
  default?: unknown;
}

interface ConfigMissionPreset {
  preset_id: string;
  type: 'config_mission';
  category: string;
  description: string;
  inputs: Record<string, PresetInput>;
  pipeline: string;
  write_targets: string[];
  authority_role: string;
  notes?: string;
}

interface ConfigMissionBrief {
  instance_id: string;
  preset_id: string;
  tenant: string;
  inputs: Record<string, string>;
  status: 'draft' | 'applying' | 'applied' | 'failed';
  created_at: string;
  applied_at?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PRESET_DIR = 'knowledge/product/config-missions';

function instanceDir(tenant: string, instanceId: string): string {
  return `knowledge/confidential/${tenant}/config-missions/${instanceId}`;
}

function briefPath(tenant: string, instanceId: string): string {
  return nodePath.join(instanceDir(tenant, instanceId), 'brief.json');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPreset(presetId: string): ConfigMissionPreset {
  const p = nodePath.join(PRESET_DIR, `${presetId}.json`);
  const raw = safeReadFile(p, { encoding: 'utf8' });
  if (!raw) throw new Error(`Preset not found: ${presetId}`);
  return JSON.parse(raw as string) as ConfigMissionPreset;
}

function listPresets(): ConfigMissionPreset[] {
  const entries = safeReaddir(PRESET_DIR) as string[];
  return entries
    .filter(f => f.endsWith('.json'))
    .map(f => {
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
    logger.info('No config mission presets found.');
    return;
  }
  console.log('\nAvailable config mission presets:\n');
  console.log('  PRESET ID                        CATEGORY             DESCRIPTION');
  console.log('  ' + '─'.repeat(80));
  for (const p of presets) {
    const id = p.preset_id.padEnd(32);
    const cat = p.category.padEnd(20);
    console.log(`  ${id} ${cat} ${p.description}`);
  }
  console.log(`\nTotal: ${presets.length} preset(s)`);
  console.log(`\nTo create a mission: pnpm config-mission create --preset <id> --tenant <slug> [--input key=value ...]`);
}

function cmdCreate(argv: string[]): void {
  const getOpt = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };
  const getMulti = (flag: string): string[] => {
    const vals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && argv[i + 1]) vals.push(argv[++i]);
    }
    return vals;
  };

  const presetId = getOpt('--preset');
  const tenant = getOpt('--tenant');
  if (!presetId) throw new Error('--preset is required');
  if (!tenant) throw new Error('--tenant is required');

  const preset = loadPreset(presetId);
  const inputs = parseInputArgs(getMulti('--input'));

  // Apply defaults
  for (const [key, def] of Object.entries(preset.inputs)) {
    if (!(key in inputs) && def.default !== undefined) {
      inputs[key] = String(def.default);
    }
  }
  inputs.tenant = tenant;

  const errors = validateInputs(preset, inputs);
  if (errors.length > 0) {
    console.error('\n❌ Input validation failed:\n');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }

  const instanceId = generateInstanceId();
  inputs.instance_id = instanceId;

  const brief: ConfigMissionBrief = {
    instance_id: instanceId,
    preset_id: presetId,
    tenant,
    inputs,
    status: 'draft',
    created_at: new Date().toISOString(),
  };

  const dir = instanceDir(tenant, instanceId);
  safeMkdir(dir, { recursive: true });
  safeWriteFile(briefPath(tenant, instanceId), JSON.stringify(brief, null, 2));

  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'worker',
    action: 'config_mission.create',
    operation: `${presetId}/${instanceId}`,
    result: 'completed',
    metadata: { preset_id: presetId, tenant, instance_id: instanceId },
  });

  console.log(`\n✅ Config mission created: ${instanceId}`);
  console.log(`   Preset:  ${presetId}`);
  console.log(`   Tenant:  ${tenant}`);
  console.log(`   Brief:   ${briefPath(tenant, instanceId)}`);
  console.log(`\nTo apply: pnpm config-mission apply --tenant ${tenant} --id ${instanceId}`);
}

function cmdStatus(argv: string[]): void {
  const getOpt = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const tenant = getOpt('--tenant');
  const id = getOpt('--id');
  if (!tenant) throw new Error('--tenant is required');

  const missionsDir = `knowledge/confidential/${tenant}/config-missions`;
  if (!safeExistsSync(missionsDir)) {
    logger.info(`No config missions found for tenant: ${tenant}`);
    return;
  }

  const entries = (safeReaddir(missionsDir) as string[]).filter(e => e.startsWith('cfg-'));
  const targets = id ? entries.filter(e => e === id) : entries;

  if (targets.length === 0) {
    logger.info(id ? `Config mission ${id} not found for tenant ${tenant}` : `No config missions for tenant ${tenant}`);
    return;
  }

  console.log(`\nConfig missions for tenant '${tenant}':\n`);
  console.log('  ID                         PRESET                           STATUS     CREATED');
  console.log('  ' + '─'.repeat(85));

  for (const entry of targets) {
    try {
      const raw = safeReadFile(briefPath(tenant, entry), { encoding: 'utf8' }) as string;
      const brief = JSON.parse(raw) as ConfigMissionBrief;
      const instanceCol = brief.instance_id.padEnd(26);
      const presetCol = brief.preset_id.padEnd(32);
      const statusCol = brief.status.padEnd(10);
      const created = brief.created_at.slice(0, 10);
      console.log(`  ${instanceCol} ${presetCol} ${statusCol} ${created}`);
    } catch {
      console.log(`  ${entry.padEnd(26)} (unreadable brief)`);
    }
  }
}

async function cmdApply(argv: string[]): Promise<void> {
  const getOpt = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const tenant = getOpt('--tenant');
  const id = getOpt('--id');
  if (!tenant) throw new Error('--tenant is required');
  if (!id) throw new Error('--id is required');

  const bPath = briefPath(tenant, id);
  if (!safeExistsSync(bPath)) throw new Error(`Config mission not found: ${bPath}`);

  const raw = safeReadFile(bPath, { encoding: 'utf8' }) as string;
  const brief = JSON.parse(raw) as ConfigMissionBrief;

  if (brief.status === 'applied') {
    logger.info(`Config mission ${id} is already applied.`);
    return;
  }

  const preset = loadPreset(brief.preset_id);

  // Update status → applying
  brief.status = 'applying';
  safeWriteFile(bPath, JSON.stringify(brief, null, 2));

  logger.info(`[CONFIG_MISSION] Applying ${brief.preset_id} for tenant ${tenant}…`);

  try {
    // Delegate execution to run_pipeline with the mission's inputs as context
    const inputEnv = Object.entries(brief.inputs)
      .map(([k, v]) => `INPUT_${k.toUpperCase()}=${JSON.stringify(v)}`)
      .join(' ');

    const pipelinePath = preset.pipeline;
    safeExec(
      'sh',
      ['-c',
       `KYBERION_PERSONA=worker SYSTEM_ROLE=system_configurator ${inputEnv} ` +
       `node dist/scripts/run_pipeline.js --input ${pipelinePath}`],
      { cwd: pathResolver.rootDir() }
    );

    brief.status = 'applied';
    brief.applied_at = new Date().toISOString();
    safeWriteFile(bPath, JSON.stringify(brief, null, 2));

    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'worker',
      action: 'config_mission.apply',
      operation: `${brief.preset_id}/${id}`,
      result: 'completed',
      metadata: { preset_id: brief.preset_id, tenant, instance_id: id },
    });

    console.log(`\n✅ Config mission ${id} applied successfully.`);
    if (preset.notes) console.log(`\n💡 ${preset.notes}`);
  } catch (err) {
    brief.status = 'failed';
    brief.error = String(err);
    safeWriteFile(bPath, JSON.stringify(brief, null, 2));

    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'worker',
      action: 'config_mission.apply',
      operation: `${brief.preset_id}/${id}`,
      result: 'failed',
      metadata: { preset_id: brief.preset_id, tenant, instance_id: id, error: String(err) },
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error('Usage: pnpm config-mission <list|create|status|apply> [options]');
  console.error('  pnpm config-mission help');
  console.error('  pnpm config-mission create --preset <id> --tenant <slug> [--input key=value ...]');
  console.error('  pnpm config-mission status --tenant <slug> [--id <cfg-id>]');
  console.error('  pnpm config-mission apply --tenant <slug> --id <cfg-id>');
}

async function main(): Promise<void> {
  const [,, command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(command ? 0 : 2);
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
    case 'apply':
      await cmdApply(rest);
      break;
    default:
      console.error(`Unknown command: ${command ?? '(none)'}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(err => {
  logger.error(String(err));
  process.exit(1);
});
