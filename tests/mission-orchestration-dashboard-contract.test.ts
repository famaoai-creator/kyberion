import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('mission orchestration dashboard contract', () => {
  it('shows mission orchestration state in the sovereign dashboard', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    expect(dashboard).toContain('COMPANY OVERVIEW');
    expect(dashboard).toContain('resolveCompany');
    expect(dashboard).toContain('buildCompanyVisionRef');
    expect(dashboard).toContain('resolveFinanceControllerDecision');
    expect(dashboard).toContain('summarizeApprovalAuditDrilldown');
    expect(dashboard).toContain('ONBOARDING HOME');
    expect(dashboard).toContain('TENANT CONTEXT');
    expect(dashboard).toContain('CONNECTION REVIEW');
    expect(dashboard).toContain('STARTER MISSION');
    expect(dashboard).toContain('register-presentation-preference-profile');
    expect(dashboard).toContain('MISSION ORCHESTRATION');
    expect(dashboard).toContain('OWNER SUMMARIES');
    expect(dashboard).toContain('RUNTIME LEASE DOCTOR');
    expect(dashboard).toContain('SURFACE OUTBOX');
    expect(dashboard).toContain('PLAN READY');
    expect(dashboard).toContain('readCanonicalWorkGraph');
  });

  it('renders the company overview section in once mode', () => {
    const output = execFileSync(
      'node',
      [
        '--import',
        path.join(rootDir, 'scripts', 'ts-loader.mjs'),
        path.join(rootDir, 'scripts', 'sovereign_dashboard.ts'),
        '--once',
        '--focus',
        'onboarding',
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
      }
    );

    expect(output).toContain('COMPANY OVERVIEW');
    expect(output).toContain('Company:');
    expect(output).toContain('Vision:');
    expect(output).toContain('OKR:');
    expect(output).toContain('Approval audit:');
  });

  it('shows mission intelligence in Chronos default view', () => {
    const page = read('presence/displays/chronos-mirror-v2/src/app/page.tsx');
    // SX: page.tsx was split into a shell, the legacy sections, and a static
    // config module; each label/route now lives in the file that owns it.
    const legacySections = read(
      'presence/displays/chronos-mirror-v2/src/app/ChronosMirrorLegacySections.tsx'
    );
    const pageConfig = read('presence/displays/chronos-mirror-v2/src/app/chronos-page-config.ts');
    // SX: MissionIntelligence.tsx was split into per-panel modules. The contract
    // is that the MissionIntelligence surface as a whole still renders all of
    // this, so assert against the whole family rather than a single file.
    const component = [
      'MissionIntelligence.tsx',
      'MissionIntelligenceAgentTrafficPanel.tsx',
      'MissionIntelligenceApprovalsPanel.tsx',
      'MissionIntelligenceDangerousActionDialog.tsx',
      'MissionIntelligenceMissionPanel.tsx',
      'MissionIntelligencePrimitives.tsx',
      'MissionIntelligenceRuntimePanel.tsx',
      'MissionIntelligenceStatusGate.tsx',
      'MissionIntelligenceSurfaceOverview.tsx',
      'MissionIntelligenceTypes.ts',
      'MissionIntelligenceViewHelpers.tsx',
    ]
      .map((file) => read(`presence/displays/chronos-mirror-v2/src/components/${file}`))
      .join('\n');
    // SX: the intelligence route's control/observation data collectors were
    // extracted into sibling modules; the route handler is the three together.
    const route = ['route.ts', 'intelligence-control-data.ts', 'intelligence-observation-data.ts']
      .map((file) => read(`presence/displays/chronos-mirror-v2/src/app/api/intelligence/${file}`))
      .join('\n');
    const streamRoute = read(
      'presence/displays/chronos-mirror-v2/src/app/api/intelligence/stream/route.ts'
    );
    const messageFeed = read('presence/displays/chronos-mirror-v2/src/lib/agent-message-feed.ts');
    const agentRoute = read('presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts');

    expect(page).toContain('MissionIntelligence');
    // UX-03: the label moved into the vocabulary catalog; the page renders it via its key.
    expect(legacySections).toContain("uxText('chronos_jump_to_section'");
    const vocabulary = read('knowledge/product/orchestration/user-facing-vocabulary.json');
    expect(vocabulary).toContain('Jump to section');
    expect(pageConfig).toContain("uxText('chronos_qa_action_prereq_check'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_setup_report'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_schedule_tick'");
    expect(pageConfig).toContain("uxText('chronos_qa_action_schedule_list'");
    expect(pageConfig).toContain("uxText('chronos_sc_toolchain_label'");
    expect(page).toContain('mission-control-plane');
    expect(legacySections).toContain('runtime-lease-doctor');
    expect(page).toContain('recent-surface-outbox');
    expect(component).toContain('Mission Control');
    expect(component).toContain('Company Context');
    expect(component).toContain('OKR');
    expect(component).toContain('audit');
    expect(component).toContain('finance controller');
    expect(component).toContain('audit drilldown');
    expect(component).toContain('control summary');
    expect(component).toContain('requested by');
    expect(component).toContain("'chronos_recent_control_actions'");
    expect(component).toContain("'chronos_show_details'");
    expect(component).toContain("'chronos_jump_to_target'");
    expect(component).toContain('show latest action');
    expect(component).toContain('retry latest action');
    expect(component).toContain('operator guidance');
    expect(component).toContain('next valid actions');
    expect(component).toContain('safe actions');
    expect(component).toContain('risky actions');
    expect(component).toContain('approval required');
    expect(component).toContain('Orchestration Audit');
    expect(component).toContain('Browser Session Oversight');
    expect(component).toContain('recent browser trail');
    expect(component).toContain('close session');
    expect(component).toContain('restart session');
    expect(component).toContain('strict or hint mode');
    expect(component).toContain('Agent Traffic');
    expect(component).toContain('Selected Mission Thread');
    expect(component).toContain('A2A Handoff Trail');
    expect(component).toContain('all missions');
    expect(component).toContain('a2a handoff');
    expect(component).toContain('pin mission thread');
    expect(component).toContain('mission pinned');
    expect(component).toContain("url.searchParams.set('mission', selectedMissionId)");
    expect(component).toContain("const mission = params.get('mission')");
    expect(component).toContain('new EventSource(');
    expect(component).toContain("'/api/intelligence/stream'");
    expect(component).toContain('No mission-scoped agent messages observed yet.');
    expect(component).toContain("'chronos_owner_summaries'");
    expect(component).toContain('Delivery Exceptions');
    expect(component).toContain('clear outbox');
    expect(component).toContain('Surface Control');
    expect(component).toContain('mission_controller');
    expect(component).toContain('surface_runtime');
    expect(component).toContain('accessRole');
    expect(component).toContain('localhost auto-admin');
    expect(component).toContain('Runtime Governance');
    expect(component).toContain('cleanup_runtime_lease');
    expect(component).toContain('restart_runtime_lease');
    expect(route).toContain('activeMissions');
    expect(route).toContain('controlSummary');
    expect(route).toContain('controlTone');
    expect(route).toContain('controlRequestedBy');
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
    expect(route).toContain('agentMessages');
    expect(route).toContain('a2aHandoffs');
    expect(route).toContain('collectAgentMessages');
    expect(route).toContain('collectA2AHandoffs');
    expect(messageFeed).toContain('a2a_message_routed');
    expect(messageFeed).toContain('handoff from');
    expect(messageFeed).toContain('prompt');
    expect(messageFeed).toContain('response');
    expect(streamRoute).toContain('text/event-stream');
    expect(streamRoute).toContain('collectAgentMessages');
    expect(streamRoute).toContain('collectA2AHandoffs');
    expect(streamRoute).toContain('collectRecentEvents');
    expect(streamRoute).toContain('collectControlActions');
    expect(streamRoute).toContain('collectControlActionDetails');
    expect(streamRoute).toContain('collectOwnerSummaries');
    expect(streamRoute).toContain('collectBrowserSessions');
    expect(streamRoute).toContain('buildRuntimeTopology');
    expect(streamRoute).toContain('listAgentRuntimeSnapshots');
    expect(streamRoute).toContain('runtimeTopology');
    expect(streamRoute).toContain('runtimeSummary');
    expect(streamRoute).toContain('retry: 3000');
    expect(route).toContain('controlActionCatalog');
    expect(route).toContain('controlActionAvailability');
    expect(route).toContain('resolveCompany');
    expect(route).toContain('buildCompanyVisionRef');
    expect(route).toContain('company');
    expect(route).toContain('okr');
    expect(route).toContain('approvalAudit');
    expect(route).toContain('approvalAuditDrilldown');
    expect(route).toContain('financeController');
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
    expect(route).toContain('browserSessions');
    expect(route).toContain('close_browser_session');
    expect(route).toContain('restart_browser_session');
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
    expect(route).toContain('resolveFinanceControllerDecision');
    expect(route).toContain('summarizeApprovalAuditDrilldown');
    expect(agentRoute).toContain('RUN_PIPELINE_PATTERN');
    expect(agentRoute).toContain('dist/scripts/run_pipeline.js');
    expect(agentRoute).toContain('prereq-check');
    expect(agentRoute).toContain('setup-report');
    expect(agentRoute).toContain('schedule-tick');
    expect(agentRoute).toContain('schedule-list');
    expect(agentRoute).toContain('doctor');
    expect(agentRoute).toContain('surfaces-setup');
    expect(agentRoute).toContain('services-setup');
    expect(agentRoute).toContain('reasoning-setup');
    expect(agentRoute).toContain("import('@agent/core/core')");
    expect(route).toContain("from '../../../lib/intelligence-primitives'");
    expect(route).toContain('emitMissionOrchestrationObservation');
  });

  it('keeps core public entrypoint free of presence-actuator runtime dependency', () => {
    const coreIndex = read('libs/core/index.ts');

    expect(coreIndex).not.toContain('presenceAction');
    expect(coreIndex).not.toContain('presence-actuator');

    const coreDistPath = path.join(process.cwd(), 'libs/core/dist/index.js');
    if (fs.existsSync(coreDistPath)) {
      const coreDistIndex = fs.readFileSync(coreDistPath, 'utf8');
      expect(coreDistIndex).not.toContain('presence-actuator');
      expect(coreDistIndex).not.toContain('presenceAction');
    }
  });
});
