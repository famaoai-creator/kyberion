import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { buildAgentCollaborationProjection } from '@agent/core/agent-collaboration-projection';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface CheckResult {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
}

export const VITAL_CHECK_USAGE =
  'Usage: pnpm kyberion vital [--format=json|text] [--exit-on-missing]';

export function fileCheck(
  id: string,
  label: string,
  relPath: string,
  kind: 'file' | 'dir'
): CheckResult {
  const full = pathResolver.resolve(relPath);
  try {
    const stat = safeStat(relPath);
    const expected = kind === 'dir' ? stat.isDirectory() : stat.isFile();
    return expected
      ? { id, label, status: 'ok', detail: full }
      : { id, label, status: 'error', detail: `expected ${kind} at ${full}` };
  } catch {
    return { id, label, status: 'missing', detail: full };
  }
}

export function activeMissionCount(): number {
  const roots = ['active/missions', 'knowledge/personal/missions'];
  let count = 0;
  for (const root of roots) {
    if (!safeExistsSync(root)) continue;
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      try {
        const entries = safeReaddir(dir);
        for (const entryName of entries) {
          const full = path.join(dir, entryName);
          try {
            const stat = safeStat(full);
            if (stat.isDirectory()) {
              stack.push(full);
            } else if (stat.isFile() && entryName === 'mission-state.json') {
              try {
                const txt = safeReadFile(full, { encoding: 'utf8' }) as string;
                if (/"status"\s*:\s*"active"/.test(txt)) count += 1;
              } catch {
                // skip unreadable state files
              }
            }
          } catch {
            // skip entries we cannot inspect
          }
        }
      } catch {
        continue;
      }
    }
  }
  return count;
}

function profileRoot(): string {
  return resolveActiveProfileRoot();
}

function profilePath(subPath: string): string {
  return path.join(profileRoot(), subPath);
}

export function buildVitalReport() {
  const checks: CheckResult[] = [
    fileCheck('physical_foundation', 'Physical Foundation', 'node_modules', 'dir'),
    fileCheck('system_build', 'System Build', 'dist', 'dir'),
    fileCheck(
      'chronos_build',
      'Chronos UI Build',
      'presence/displays/chronos-mirror-v2/.next',
      'dir'
    ),
    fileCheck(
      'surface_manifest_snapshot',
      'Surface Manifest Snapshot',
      'knowledge/product/governance/active-surfaces.json',
      'file'
    ),
    fileCheck(
      'surface_manifests_dir',
      'Surface Manifests Directory',
      'knowledge/product/governance/surfaces',
      'dir'
    ),
    fileCheck(
      'surface_state',
      'Surface Runtime State',
      'active/shared/runtime/surfaces/state.json',
      'file'
    ),
    fileCheck('sovereign_identity', 'Sovereign Identity', profilePath('my-identity.json'), 'file'),
    fileCheck('agent_identity', 'Agent Identity', profilePath('agent-identity.json'), 'file'),
    fileCheck('sovereign_vision', 'Sovereign Vision', profilePath('my-vision.md'), 'file'),
    fileCheck(
      'onboarding_summary',
      'Onboarding Summary',
      profilePath('onboarding/onboarding-summary.md'),
      'file'
    ),
  ];

  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.status === 'ok').length,
    missing: checks.filter((c) => c.status === 'missing').length,
    error: checks.filter((c) => c.status === 'error').length,
  };

  return {
    generated_at: new Date().toISOString(),
    overall: summary.missing === 0 && summary.error === 0 ? 'healthy' : 'attention',
    summary,
    checks,
    active_mission_count: activeMissionCount(),
    collaboration: (() => {
      const projection = buildAgentCollaborationProjection({ limit: 500 });
      return {
        events: projection.overview.events,
        missions: projection.overview.missions,
        tasks: projection.overview.tasks,
        agents: projection.overview.agents,
        attention: projection.attention.length,
        partial: projection.partial,
        status_flags: projection.status_flags,
      };
    })(),
  };
}

export async function formatVitalReport(
  report: ReturnType<typeof buildVitalReport>
): Promise<string> {
  return report.checks
    .map((check) => {
      const icon = check.status === 'ok' ? '✅' : check.status === 'missing' ? '⚠️ ' : '❌';
      return `${icon} ${check.label}: ${check.status.toUpperCase()}${check.detail ? ` (${check.detail})` : ''}`;
    })
    .concat([`🚀 Active Missions: ${report.active_mission_count}`, `Overall: ${report.overall}`])
    .join('\n');
}

export async function main(args: string[] = []): Promise<{
  report?: ReturnType<typeof buildVitalReport>;
  status: number;
  text?: string;
  help?: string;
}> {
  if (args.includes('--help') || args.includes('-h')) {
    return { status: 0, help: VITAL_CHECK_USAGE };
  }

  const argv = await createStandardYargs(['node', 'vital_check', ...args])
    .option('format', { type: 'string', choices: ['json', 'text'] as const, default: 'json' })
    .option('exit-on-missing', { type: 'boolean', default: true })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();

  const result = buildVitalReport();
  return {
    report: result,
    status: argv['exit-on-missing'] && result.overall !== 'healthy' ? 3 : 0,
    ...(argv.format === 'text' && !argv.json ? { text: await formatVitalReport(result) } : {}),
  };
}

if (
  isDirectScript(import.meta.url, 'vital_check.ts') ||
  isDirectScript(import.meta.url, 'vital_check.js')
)
  void defineScript({
    name: 'vital:check',
    flags: ['json'],
    async run(context) {
      const result = await main(context.argv);
      if (result.help) context.print(context.json ? result : result.help);
      else if (result.report) context.print(result.text ?? result.report);
      if (result.status !== 0) throw new ScriptExitError(result.status, '', true, result);
    },
  })();
