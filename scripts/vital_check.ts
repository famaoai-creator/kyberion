import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { customerResolver, pathResolver, safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core';

interface CheckResult {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
}

export function fileCheck(id: string, label: string, relPath: string, kind: 'file' | 'dir'): CheckResult {
  const full = pathResolver.resolve(relPath);
  try {
    const stat = safeStat(relPath);
    const expected = kind === 'dir' ? stat.isDirectory() : stat.isFile();
    return expected ? { id, label, status: 'ok', detail: full } : { id, label, status: 'error', detail: `expected ${kind} at ${full}` };
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
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}

function profilePath(subPath: string): string {
  return path.join(profileRoot(), subPath);
}

export function buildVitalReport() {
  const checks: CheckResult[] = [
    fileCheck('physical_foundation', 'Physical Foundation', 'node_modules', 'dir'),
    fileCheck('system_build', 'System Build', 'dist', 'dir'),
    fileCheck('chronos_build', 'Chronos UI Build', 'presence/displays/chronos-mirror-v2/.next', 'dir'),
    fileCheck('surface_manifest_snapshot', 'Surface Manifest Snapshot', 'knowledge/public/governance/active-surfaces.json', 'file'),
    fileCheck('surface_manifests_dir', 'Surface Manifests Directory', 'knowledge/public/governance/surfaces', 'dir'),
    fileCheck('surface_state', 'Surface Runtime State', 'active/shared/runtime/surfaces/state.json', 'file'),
    fileCheck('sovereign_identity', 'Sovereign Identity', profilePath('my-identity.json'), 'file'),
    fileCheck('agent_identity', 'Agent Identity', profilePath('agent-identity.json'), 'file'),
    fileCheck('sovereign_vision', 'Sovereign Vision', profilePath('my-vision.md'), 'file'),
    fileCheck('onboarding_summary', 'Onboarding Summary', profilePath('onboarding/onboarding-summary.md'), 'file'),
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
  };
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('format', { type: 'string', choices: ['json', 'text'] as const, default: 'json' })
    .option('exit-on-missing', { type: 'boolean', default: true })
    .strict()
    .parse();

  const result = buildVitalReport();

  if (argv.format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    for (const c of result.checks) {
      const icon = c.status === 'ok' ? '✅' : c.status === 'missing' ? '⚠️ ' : '❌';
      console.log(`${icon} ${c.label}: ${c.status.toUpperCase()}${c.detail ? ` (${c.detail})` : ''}`);
    }
    console.log(`🚀 Active Missions: ${result.active_mission_count}`);
    console.log(`Overall: ${result.overall}`);
  }

  if (argv['exit-on-missing'] && result.overall !== 'healthy') {
    process.exit(3);
  }
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isMainModule) {
  main().catch((err) => {
    console.error('vital_check failed:', err.message || err);
    process.exit(1);
  });
}
