import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

const rootDir = process.cwd();

function read(relPath: string): string {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

describe('mission orchestration dashboard contract', () => {
  it('shows mission orchestration state in the sovereign dashboard', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    expect(dashboard).toContain('MISSION ORCHESTRATION');
    expect(dashboard).toContain('OWNER SUMMARIES');
    expect(dashboard).toContain('RUNTIME LEASE DOCTOR');
    expect(dashboard).toContain('SURFACE OUTBOX');
    expect(dashboard).toContain('PLAN READY');
    expect(dashboard).toContain('NEXT_TASKS.json');
  });

  it('shows mission intelligence in Chronos default view', () => {
    const page = read('presence/displays/chronos-mirror-v2/src/app/page.tsx');
    const component = read('presence/displays/chronos-mirror-v2/src/components/MissionIntelligence.tsx');
    const route = read('presence/displays/chronos-mirror-v2/src/app/api/intelligence/route.ts');
    const agentRoute = read('presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts');

    expect(page).toContain('MissionIntelligence');
    expect(component).toContain('Mission Control Plane');
    expect(component).toContain('control summary');
    expect(component).toContain('Control Action Queue');
    expect(component).toContain('show details');
    expect(component).toContain('jump to target');
    expect(component).toContain('show latest action');
    expect(component).toContain('retry latest action');
    expect(component).toContain('operator guidance');
    expect(component).toContain('next valid actions');
    expect(component).toContain('safe actions');
    expect(component).toContain('risky actions');
    expect(component).toContain('approval required');
    expect(component).toContain('Recent Orchestration Events');
    expect(component).toContain('Owner Summaries');
    expect(component).toContain('Recent Surface Outbox');
    expect(component).toContain('clear outbox');
    expect(component).toContain('Surface Control');
    expect(component).toContain('mission_controller');
    expect(component).toContain('surface_runtime');
    expect(component).toContain('accessRole');
    expect(component).toContain('Runtime Lease Doctor');
    expect(component).toContain('cleanup_runtime_lease');
    expect(component).toContain('restart_runtime_lease');
    expect(route).toContain('activeMissions');
    expect(route).toContain('controlSummary');
    expect(route).toContain('controlTone');
    expect(route).toContain('pendingMissionTargets');
    expect(route).toContain('pendingSurfaceTargets');
    expect(route).toContain(' pending');
    expect(route).toContain('execution ready');
    expect(route).toContain('planning pending');
    expect(route).toContain('surfaces');
    expect(route).toContain('controlSummary');
    expect(route).toContain('controlTone');
    expect(route).toContain('needs attention');
    expect(route).toContain('stable');
    expect(route).toContain('stopped');
    expect(route).toContain('recentEvents');
    expect(route).toContain('controlActionCatalog');
    expect(route).toContain('controlActionAvailability');
    expect(route).toContain('approvalRequired');
    expect(route).toContain('disabledReason');
    expect(route).toContain('Mission is already active.');
    expect(route).toContain('Surface is already running.');
    expect(route).toContain('Surface is already stopped.');
    expect(route).toContain('finish');
    expect(route).toContain('refresh team');
    expect(route).toContain('reconcile surfaces');
    expect(route).toContain('controlActions');
    expect(route).toContain('controlActionDetails');
    expect(route).toContain('ownerSummaries');
    expect(route).toContain('surfaceOutbox');
    expect(route).toContain('recentSurfaceOutbox');
    expect(route).toContain('clear_surface_outbox');
    expect(route).toContain('mission_control');
    expect(route).toContain('surface_control');
    expect(route).toContain('mission_control_requested');
    expect(route).toContain('surface_control_requested');
    expect(route).toContain('startMissionOrchestrationWorker');
    expect(route).toContain('chronos_localadmin');
    expect(route).toContain('roleToMissionRole');
    expect(route).toContain('surface_outbox_cleared');
    expect(route).toContain('runtimeLeases');
    expect(route).toContain('runtimeDoctor');
    expect(route).toContain('MISSION_RUNTIME_REMEDIATION');
    expect(route).toContain('runtime-remediation');
    expect(route).toContain('runtime_lease_remediation_applied');
    expect(route).toContain('cleanup_runtime_lease');
    expect(route).toContain('restart_runtime_lease');
    expect(route).toContain('collectControlActionCatalog');
    expect(route).toContain('collectControlActionAvailability');
    expect(agentRoute).toContain('RUN_PIPELINE_PATTERN');
    expect(agentRoute).toContain('dist/scripts/run_pipeline.js');
  });

  it('keeps core public entrypoint free of presence-actuator runtime dependency', () => {
    const coreIndex = read('libs/core/index.ts');
    const coreDistIndex = read('libs/core/dist/index.js');

    expect(coreIndex).not.toContain('presenceAction');
    expect(coreIndex).not.toContain('presence-actuator');
    expect(coreDistIndex).not.toContain('presence-actuator');
    expect(coreDistIndex).not.toContain('presenceAction');
  });
});
