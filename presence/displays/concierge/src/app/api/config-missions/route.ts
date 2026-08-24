import { NextRequest, NextResponse } from 'next/server';
import * as path from 'node:path';
import {
  buildExecutionEnv,
  loadJson,
  listTenantProfileSlugs,
  pathResolver,
  safeExecResult,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  secureIo,
  withExecutionContext,
} from '@agent/core';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * CS-03 ガバナンス設定の config-mission 化 — governance changes from the GUI
 * go exclusively through config-mission presets (§2 catalog: config-mission
 * 経由のみ、直接 JSON 編集はさせない). This route deliberately stops at
 * CREATION: it files the change request as a draft brief via the built
 * scripts/config_mission.ts CLI, and the change takes effect only after the
 * governed mission flow (approval + gates) executes it. There is no direct
 * execution endpoint here and no direct-JSON-write path.
 *
 * GET is a pure read: presets are plain JSON under
 * knowledge/product/config-missions/ and briefs are plain JSON under
 * knowledge/confidential/{tenant}/config-missions/ — both are read directly
 * via secure-io instead of spawning the CLI's print-formatted subcommands.
 */

const PRESET_DIR_RELATIVE = 'knowledge/product/config-missions';
const SCRIPT_RELATIVE = 'dist/scripts/config_mission.js';
// Creation only writes one draft brief — bounded and quick.
const CREATE_TIMEOUT_MS = 30_000;
const MAX_RECENT = 20;
const MAX_INPUT_VALUE_CHARS = 400;
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INPUT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/i;
// Inputs the CLI fills in itself — never collected from the client.
const AUTO_INPUT_KEYS = new Set(['tenant', 'instance_id']);

interface PresetInputSpec {
  key: string;
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required: boolean;
  values?: string[];
  default?: string;
}

interface PresetSummary {
  id: string;
  category: string;
  description: string;
  inputs: PresetInputSpec[];
  /** How many governed locations the change would touch (write_targets). */
  write_target_count: number;
  write_targets: string[];
}

interface RecentConfigMission {
  id: string;
  preset: string;
  tenant: string;
  status: string;
  created_at: string;
}

function readPresets(): PresetSummary[] {
  const presetDir = pathResolver.rootResolve(PRESET_DIR_RELATIVE);
  if (!safeExistsSync(presetDir)) return [];
  const presets: PresetSummary[] = [];
  for (const name of (safeReaddir(presetDir) as string[]).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = safeReadFile(path.join(presetDir, name), { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type !== 'config_mission' || typeof parsed.preset_id !== 'string') continue;
      const inputs: PresetInputSpec[] = Object.entries(
        (parsed.inputs || {}) as Record<string, Record<string, unknown>>
      )
        .filter(([key]) => !AUTO_INPUT_KEYS.has(key))
        .map(([key, def]) => ({
          key,
          type: (['string', 'enum', 'boolean', 'secret'].includes(String(def.type))
            ? String(def.type)
            : 'string') as PresetInputSpec['type'],
          description: String(def.description || ''),
          required: def.required !== false && def.default === undefined,
          ...(Array.isArray(def.values) ? { values: def.values.map(String) } : {}),
          ...(def.default !== undefined ? { default: String(def.default) } : {}),
        }));
      const writeTargets = Array.isArray(parsed.write_targets)
        ? parsed.write_targets.map(String)
        : [];
      presets.push({
        id: parsed.preset_id,
        category: String(parsed.category || ''),
        description: String(parsed.description || ''),
        inputs,
        write_target_count: writeTargets.length,
        write_targets: writeTargets,
      });
    } catch {
      // An unreadable preset is skipped, never fabricated.
    }
  }
  return presets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function briefDirRelative(tenant: string): string {
  return `knowledge/confidential/${tenant}/config-missions`;
}

function readBrief(tenant: string, instanceId: string): Record<string, unknown> | null {
  const briefPath = pathResolver.rootResolve(
    path.join(briefDirRelative(tenant), instanceId, 'brief.json')
  );
  if (!safeExistsSync(briefPath)) return null;
  try {
    return loadJson<Record<string, unknown>>(briefPath);
  } catch {
    return null;
  }
}

function readRecentMissions(tenants: string[]): RecentConfigMission[] {
  const recent: RecentConfigMission[] = [];
  for (const tenant of tenants) {
    const dir = pathResolver.rootResolve(briefDirRelative(tenant));
    if (!safeExistsSync(dir)) continue;
    for (const entry of (safeReaddir(dir) as string[]).filter((e) => e.startsWith('cfg-'))) {
      const brief = readBrief(tenant, entry);
      if (!brief) continue;
      recent.push({
        id: String(brief.instance_id || entry),
        preset: String(brief.preset_id || ''),
        tenant,
        // Passed through verbatim; the client maps known status codes to
        // plain-language labels and shows anything unknown as-is.
        status: String(brief.status || ''),
        created_at: String(brief.created_at || ''),
      });
    }
  }
  return recent
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, MAX_RECENT);
}

export function GET() {
  try {
    const payload = withExecutionContext('sovereign_concierge', () => {
      const presets = readPresets();
      const tenants = listTenantProfileSlugs();
      const recent = secureIo.withSensitivePathMediation(() => readRecentMissions(tenants));
      return { presets, tenants, recent };
    });
    return NextResponse.json({ ok: true, ...payload });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const presetId = typeof body?.preset === 'string' ? body.preset.trim() : '';
    const tenant = typeof body?.tenant === 'string' ? body.tenant.trim() : '';
    const rawInputs =
      body?.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : {};

    if (!presetId || !PRESET_ID_PATTERN.test(presetId)) {
      return NextResponse.json(
        { ok: false, error: t('api.config.preset_invalid') },
        { status: 400 }
      );
    }
    const preset = withExecutionContext('sovereign_concierge', () => readPresets()).find(
      (candidate) => candidate.id === presetId
    );
    if (!preset) {
      return NextResponse.json(
        { ok: false, error: t('api.config.preset_invalid') },
        { status: 400 }
      );
    }

    const knownTenants = withExecutionContext('sovereign_concierge', () =>
      listTenantProfileSlugs()
    );
    if (!tenant || !knownTenants.includes(tenant)) {
      return NextResponse.json(
        { ok: false, error: t('api.config.tenant_invalid') },
        { status: 400 }
      );
    }

    // Inputs: only keys the preset declares, safe argv values (each --input
    // payload is a single `key=value` argv element; a leading '-' could read
    // as a flag, so it is refused outright).
    const declared = new Map(preset.inputs.map((input) => [input.key, input]));
    const inputs: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(rawInputs)) {
      const spec = declared.get(key);
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!spec || !INPUT_KEY_PATTERN.test(key)) {
        return NextResponse.json(
          { ok: false, error: t('api.config.input_invalid', { key }) },
          { status: 400 }
        );
      }
      if (!value) continue; // empty optional fields simply fall back to defaults
      if (
        value.startsWith('-') ||
        value.length > MAX_INPUT_VALUE_CHARS ||
        /[\r\n\0]/.test(value) ||
        (spec.type === 'enum' && spec.values && !spec.values.includes(value)) ||
        (spec.type === 'boolean' && !['true', 'false'].includes(value))
      ) {
        return NextResponse.json(
          { ok: false, error: t('api.config.input_invalid', { key }) },
          { status: 400 }
        );
      }
      inputs[key] = value;
    }
    for (const input of preset.inputs) {
      if (input.required && !(input.key in inputs)) {
        return NextResponse.json(
          { ok: false, error: t('api.config.input_missing', { key: input.key }) },
          { status: 400 }
        );
      }
    }

    const rootDir = pathResolver.rootDir();
    const scriptPath = pathResolver.rootResolve(SCRIPT_RELATIVE);
    if (!safeExistsSync(scriptPath)) {
      console.error(`[concierge/config-missions] config-mission build missing: ${scriptPath}`);
      return NextResponse.json({ ok: false, error: t('api.config.failed') }, { status: 503 });
    }

    const args = [
      SCRIPT_RELATIVE,
      'create',
      '--preset',
      presetId,
      '--tenant',
      tenant,
      ...Object.entries(inputs).flatMap(([key, value]) => ['--input', `${key}=${value}`]),
    ];
    const result = safeExecResult(process.execPath, args, {
      env: buildExecutionEnv(process.env, 'sovereign_concierge'),
      cwd: rootDir,
      timeoutMs: CREATE_TIMEOUT_MS,
      maxOutputMB: 5,
    });

    // Full CLI output stays server-side; the UI gets a short honest verdict.
    console.log(
      `[concierge/config-missions] create preset=${presetId} tenant=${tenant} exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );

    if (result.status !== 0) {
      return NextResponse.json({ ok: false, error: t('api.config.failed') }, { status: 502 });
    }

    // Exit code 0 alone is not success: parse the CLI's own verdict line, then
    // verify the draft brief actually exists on disk before claiming anything.
    const created = result.stdout.match(/Config mission created: (cfg-\d+)/);
    const instanceId = created?.[1] || '';
    const brief = instanceId
      ? withExecutionContext('sovereign_concierge', () =>
          secureIo.withSensitivePathMediation(() => readBrief(tenant, instanceId))
        )
      : null;
    if (!brief || String(brief.instance_id) !== instanceId || brief.status !== 'draft') {
      return NextResponse.json({ ok: false, error: t('api.config.failed') }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      mission: {
        id: instanceId,
        preset: presetId,
        tenant,
        status: String(brief.status),
      },
      // The change is only FILED here — it takes effect after the governed
      // mission flow decides and executes it, never directly from this route.
      message: t('api.config.created', { id: instanceId }),
    });
  } catch (error) {
    console.error(
      `[concierge/config-missions] create route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.config.failed') }, { status: 500 });
  }
}
