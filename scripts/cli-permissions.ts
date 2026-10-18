/**
 * `pnpm kyberion permissions status [--json]`
 * `pnpm kyberion permissions warmup [--only microphone,camera,screen_recording] [--json]`
 *
 * status only probes (never prompts). warmup explicitly asks macOS for the
 * capture permissions that are still undetermined, for the terminal host app
 * this command runs in. The default warmup scope is the microphone (the
 * meeting pain point); camera / screen_recording are opt-in via --only.
 * The System Settings pane is returned for denied kinds, never opened.
 */
import { probeMacOSNativeAutomation } from '@agent/core/macos-native-automation';
import {
  DEFAULT_PERMISSION_WARMUP_KINDS,
  PERMISSION_SETTINGS_PANE,
  PERMISSION_WARMUP_KINDS,
  warmupMacOSPermissions,
  type PermissionWarmupKind,
  type PermissionWarmupResult,
} from '@agent/core/macos-permission-warmup';
import { ScriptExitError } from './lib/harness.js';

export const PERMISSIONS_USAGE = `Usage: pnpm kyberion permissions <status|warmup> [options]

  status [--json]                 Show microphone / camera / screen recording state (never prompts)
  warmup [--only <kinds>] [--json]
                                  Ask macOS for permissions that are still undetermined.
                                  <kinds>: comma list of ${PERMISSION_WARMUP_KINDS.join(' / ')}
                                  (default: microphone). Denied microphone/camera are not
                                  re-requested; the System Settings pane to enable them is
                                  printed instead (screen recording always needs that pane).

macOS grants belong to the terminal app running this command (host app).`;

export interface PermissionsDeps {
  probe: typeof probeMacOSNativeAutomation;
  warmup: typeof warmupMacOSPermissions;
}
const defaultDeps: PermissionsDeps = {
  probe: probeMacOSNativeAutomation,
  warmup: warmupMacOSPermissions,
};

function parseKinds(value: string): PermissionWarmupKind[] {
  const kinds = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = kinds.filter((kind) => !PERMISSION_WARMUP_KINDS.includes(kind as never));
  if (kinds.length === 0 || invalid.length > 0)
    throw new ScriptExitError(
      1,
      `Unknown permission kind: ${invalid.join(', ') || '(empty)'}. Use ${PERMISSION_WARMUP_KINDS.join(', ')}.`
    );
  return kinds as PermissionWarmupKind[];
}

function table(rows: string[][]): string {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderPermissionsStatus(
  probe: ReturnType<typeof probeMacOSNativeAutomation>,
  json: boolean
): string {
  const kinds = {
    microphone: probe.microphone ?? 'unknown',
    camera: probe.camera ?? 'unknown',
    screen_recording: probe.screen_recording,
  };
  if (json)
    return JSON.stringify(
      {
        host_app: probe.host_app ?? null,
        permissions: kinds,
        ...(probe.reason ? { reason: probe.reason } : {}),
      },
      null,
      2
    );
  const lines = [
    '# OS permissions',
    '',
    `- host app: ${probe.host_app ?? '(unknown)'}`,
    '',
    table([
      ['kind', 'state'],
      ['---', '---'],
      ...Object.entries(kinds).map(([kind, status]) => [kind, status]),
    ]),
  ];
  if (probe.reason) lines.push('', `> [permissions] ${probe.reason}`);
  if (Object.values(kinds).includes('not_determined'))
    lines.push(
      '',
      '> [permissions] run `pnpm kyberion permissions warmup` to request undetermined permissions'
    );
  return lines.join('\n');
}

export function renderPermissionsWarmup(result: PermissionWarmupResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  if (!result.supported)
    return `# OS permission warm-up\n\n> [permissions] not supported on this platform (${result.reason})`;
  const entries = Object.entries(result.results);
  const lines = [
    '# OS permission warm-up',
    '',
    table([
      ['kind', 'before', 'after'],
      ['---', '---', '---'],
      ...entries.map(([kind, r]) => [kind, r?.before ?? '', r?.after ?? '']),
    ]),
  ];
  for (const [kind, r] of entries)
    if (r?.remedy)
      lines.push(
        '',
        `> [permissions] ${kind} is not granted. Enable the host app in System Settings, then restart it: ${r.remedy}`
      );
  if (result.reason) lines.push('', `> [permissions] warm-up failed: ${result.reason}`);
  return lines.join('\n');
}

export async function runPermissionsCommand(
  argv: string[],
  print: (text: string) => void,
  deps: PermissionsDeps = defaultDeps
): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    print(PERMISSIONS_USAGE);
    return;
  }
  let json = false;
  let only: PermissionWarmupKind[] = [...DEFAULT_PERMISSION_WARMUP_KINDS];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--json') json = true;
    else if (value === '--verbose') continue;
    else if (value === '--only' && sub === 'warmup') {
      const next = rest[index + 1];
      if (next === undefined) throw new ScriptExitError(1, '--only requires a value');
      only = parseKinds(next);
      index += 1;
    } else throw new ScriptExitError(1, `Unknown option: ${value}\n\n${PERMISSIONS_USAGE}`);
  }
  if (sub === 'status') print(renderPermissionsStatus(deps.probe(), json));
  else if (sub === 'warmup') print(renderPermissionsWarmup(deps.warmup(only), json));
  else throw new ScriptExitError(1, `Unknown permissions command: ${sub}\n\n${PERMISSIONS_USAGE}`);
}

export { PERMISSION_SETTINGS_PANE };
