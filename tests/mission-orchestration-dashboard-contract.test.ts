import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('mission orchestration dashboard contract', () => {
  it('shows mission orchestration state in the sovereign dashboard', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    expect(dashboard).toContain('MISSION ORCHESTRATION');
    expect(dashboard).toContain('OWNER SUMMARIES');
    expect(dashboard).toContain('RUNTIME LEASE DOCTOR');
    expect(dashboard).toContain('SLACK OUTBOX');
    expect(dashboard).toContain('PLAN READY');
    expect(dashboard).toContain('NEXT_TASKS.json');
  });

  it('shows mission intelligence in Chronos default view', () => {
    const page = read('presence/displays/chronos-mirror-v2/src/app/page.tsx');
    const component = read('presence/displays/chronos-mirror-v2/src/components/MissionIntelligence.tsx');
    const route = read('presence/displays/chronos-mirror-v2/src/app/api/intelligence/route.ts');

    expect(page).toContain('MissionIntelligence');
    expect(component).toContain('Mission Control Plane');
    expect(component).toContain('Recent Orchestration Events');
    expect(component).toContain('Owner Summaries');
    expect(component).toContain('Runtime Lease Doctor');
    expect(component).toContain('cleanup_runtime_lease');
    expect(component).toContain('restart_runtime_lease');
    expect(route).toContain('activeMissions');
    expect(route).toContain('recentEvents');
    expect(route).toContain('ownerSummaries');
    expect(route).toContain('runtimeLeases');
    expect(route).toContain('runtimeDoctor');
    expect(route).toContain('runtime_lease_remediation_applied');
    expect(route).toContain('cleanup_runtime_lease');
    expect(route).toContain('restart_runtime_lease');
  });
});
