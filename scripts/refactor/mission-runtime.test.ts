import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  loadOrganizationProfile: vi.fn(),
  findMissionPath: vi.fn(),
  loadMissionTeamPlan: vi.fn(),
  resolveMissionTeamPlan: vi.fn(),
  enrichMissionTeamPlanWithOrganizationProfile: vi.fn((plan: any, organizationProfile: any) => ({
    ...plan,
    organization_profile: organizationProfile
      ? {
          organization_id: organizationProfile.organization_id,
          name: organizationProfile.name,
          default_team_template: organizationProfile.mission_defaults?.default_team_template,
          default_agent_profile: organizationProfile.mission_defaults?.default_agent_profile,
        }
      : undefined,
  })),
  writeMissionTeamPlan: vi.fn(),
  initializeMissionTeamBindings: vi.fn(),
  ensureMissionTeamRuntimeViaSupervisor: vi.fn(),
  enqueueMissionTeamPrewarmRequest: vi.fn(),
  startAgentRuntimeSupervisorForRequest: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@agent/core', () => coreMocks);

vi.mock('./mission-state.js', () => ({
  loadState: vi.fn(),
}));

import { loadState } from './mission-state.js';
import { showMissionTeam, staffMissionTeam } from './mission-runtime.js';

describe('mission-runtime organization defaults', () => {
  const mockedLoadState = vi.mocked(loadState);

  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.loadOrganizationProfile.mockReturnValue({
      organization_id: 'acme',
      name: 'Acme',
      version: '1.0.0',
      mission_defaults: {
        default_team_template: 'org-default',
        default_agent_profile: 'planner-agent',
      },
      team_defaults: {
        default_team_template: 'org-default',
        default_lifecycle_template: 'default',
      },
      llm: {
        default_profile: 'light',
      },
    });
    coreMocks.findMissionPath.mockReturnValue('/tmp/MISSION');
    mockedLoadState.mockReturnValue({
      mission_id: 'MSN-1',
      status: 'planned',
      execution_mode: 'local',
      mission_type: 'development',
      tier: 'public',
      priority: 3,
      assigned_persona: 'operator',
      confidence_score: 1,
      relationships: {},
      git: {
        branch: 'main',
        start_commit: 'abc',
        latest_commit: 'abc',
        checkpoints: [],
      },
      history: [],
    } as any);
  });

  it('threads organization profile into mission team display planning', () => {
    coreMocks.loadMissionTeamPlan.mockReturnValue(null);
    coreMocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-1',
      mission_type: 'development',
      tier: 'public',
      template: 'org-default',
      organization_profile: {
        organization_id: 'acme',
        name: 'Acme',
        default_team_template: 'org-default',
        team_template_catalog_id: 'demo-org',
        default_agent_profile: 'planner-agent',
      },
      generated_at: '2026-01-01T00:00:00.000Z',
      assignments: [],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    showMissionTeam('msn-1', false, '/workspace/root');

    expect(coreMocks.loadOrganizationProfile).toHaveBeenCalledWith('/workspace/root');
    expect(coreMocks.resolveMissionTeamPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-1',
        organizationProfile: expect.objectContaining({
          organization_id: 'acme',
        }),
      }),
    );
    expect(coreMocks.enrichMissionTeamPlanWithOrganizationProfile).not.toHaveBeenCalled();
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[team] org=Acme (acme) template=org-default default=org-default catalog=demo-org'),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[team] assignments=0 required=0 assigned=0 unfilled_required=0'),
    );
    expect(coreMocks.writeMissionTeamPlan).toHaveBeenCalledWith('/tmp/MISSION', expect.any(Object));
    expect(coreMocks.initializeMissionTeamBindings).toHaveBeenCalledWith('/tmp/MISSION', expect.any(Object));
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('threads organization profile into staffing fallback planning', async () => {
    coreMocks.loadMissionTeamPlan.mockReturnValue(null);
    coreMocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-2',
      mission_type: 'development',
      tier: 'public',
      template: 'org-default',
      organization_profile: {
        organization_id: 'acme',
        name: 'Acme',
        default_team_template: 'org-default',
        team_template_catalog_id: 'demo-org',
        default_agent_profile: 'planner-agent',
      },
      generated_at: '2026-01-01T00:00:00.000Z',
      assignments: [],
    });
    coreMocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-2',
        organization_profile: {
          organization_id: 'acme',
          name: 'Acme',
          default_team_template: 'org-default',
          default_agent_profile: 'planner-agent',
        },
        assignments: [],
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await staffMissionTeam('msn-2', '/workspace/root');

    expect(coreMocks.loadOrganizationProfile).toHaveBeenCalledWith('/workspace/root');
    expect(coreMocks.resolveMissionTeamPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-2',
        organizationProfile: expect.objectContaining({
          organization_id: 'acme',
        }),
      }),
    );
    expect(coreMocks.enrichMissionTeamPlanWithOrganizationProfile).not.toHaveBeenCalled();
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[staff] org=Acme (acme) default=org-default catalog=default assignments=0'),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[staff] spawned=0 already_ready=0 unfilled=0 failed=0'),
    );
    expect(coreMocks.writeMissionTeamPlan).toHaveBeenCalledWith('/tmp/MISSION', expect.any(Object));
    expect(coreMocks.initializeMissionTeamBindings).toHaveBeenCalledWith('/tmp/MISSION', expect.any(Object));
    expect(coreMocks.ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-2',
        requestedBy: 'mission_controller',
      }),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[staff] org=Acme (acme) default=org-default catalog=default assignments=0'),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[staff] spawned=0 already_ready=0 unfilled=0 failed=0'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"organization_profile"'),
    );
    logSpy.mockRestore();
  });

  it('enriches an existing mission plan with organization metadata before displaying it', () => {
    coreMocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-3',
      mission_type: 'development',
      tier: 'public',
      template: 'default',
      generated_at: '2026-01-01T00:00:00.000Z',
      assignments: [],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    showMissionTeam('msn-3', false, '/workspace/root');

    expect(coreMocks.enrichMissionTeamPlanWithOrganizationProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        mission_id: 'MSN-3',
      }),
      expect.objectContaining({
        organization_id: 'acme',
      }),
    );
    expect(coreMocks.writeMissionTeamPlan).toHaveBeenCalledWith(
      '/tmp/MISSION',
      expect.objectContaining({
        organization_profile: expect.objectContaining({
          organization_id: 'acme',
          name: 'Acme',
        }),
      }),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[team] org=Acme (acme) template=default default=org-default catalog=default'),
    );
    expect(coreMocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[team] assignments=0 required=0 assigned=0 unfilled_required=0'),
    );
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
