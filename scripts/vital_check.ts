import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { pathResolver } from '@agent/core';

interface CheckResult {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
}

function fileCheck(id: string, label: string, relPath: string, kind: 'file' | 'dir'): CheckResult {
  const full = path.join(pathResolver.rootDir(), relPath);
  try {
    const stat = fs.statSync(full);
    const expected = kind === 'dir' ? stat.isDirectory() : stat.isFile();
    return expected ? { id, label, status: 'ok', detail: full } : { id, label, status: 'error', detail: `expected ${kind} at ${full}` };
  } catch {
    return { id, label, status: 'missing', detail: full };
  }
}

function activeMissionCount(): number {
  const roots = ['active/missions', 'knowledge/personal/missions'].map((r) => path.join(pathResolver.rootDir(), r));
  let count = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name === 'mission-state.json') {
          try {
            const txt = fs.readFileSync(full, 'utf8');
            if (/"status"\s*:\s*"active"/.test(txt)) count += 1;
          } catch { /* skip */ }
        }
      }
    }
  }
  return count;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('format', { type: 'string', choices: ['json', 'text'] as const, default: 'json' })
    .option('exit-on-missing', { type: 'boolean', default: true })
    .strict()
    .parse();

  const checks: CheckResult[] = [
    fileCheck('physical_foundation', 'Physical Foundation', 'node_modules', 'dir'),
    fileCheck('system_build', 'System Build', 'dist', 'dir'),
    fileCheck('chronos_build', 'Chronos UI Build', 'presence/displays/chronos-mirror-v2/.next', 'dir'),
    fileCheck('surface_manifest', 'Surface Manifest', 'knowledge/public/governance/active-surfaces.json', 'file'),
    fileCheck('surface_state', 'Surface Runtime State', 'active/shared/runtime/surfaces/state.json', 'file'),
    fileCheck('sovereign_identity', 'Sovereign Identity', 'knowledge/personal/my-identity.json', 'file'),
    fileCheck('agent_identity', 'Agent Identity', 'knowledge/personal/agent-identity.json', 'file'),
    fileCheck('sovereign_vision', 'Sovereign Vision', 'knowledge/personal/my-vision.md', 'file'),
    fileCheck('onboarding_summary', 'Onboarding Summary', 'knowledge/personal/onboarding/onboarding-summary.md', 'file'),
  ];

  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.status === 'ok').length,
    missing: checks.filter((c) => c.status === 'missing').length,
    error: checks.filter((c) => c.status === 'error').length,
  };

  const result = {
    generated_at: new Date().toISOString(),
    overall: summary.missing === 0 && summary.error === 0 ? 'healthy' : 'attention',
    summary,
    checks,
    active_mission_count: activeMissionCount(),
  };

  if (argv.format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    for (const c of checks) {
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

main().catch((err) => {
  console.error('vital_check failed:', err.message || err);
  process.exit(1);
});
