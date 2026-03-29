import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { buildTrackGateReadinessSummary, buildTrackNextWorkProposal, materializeTrackArtifactSkeleton } from './sdlc-gate-readiness.js';

describe('sdlc-gate-readiness', () => {
  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_SUDO = 'true';
    safeRmSync(pathResolver.active('projects/test-sdlc-skeleton'), { recursive: true, force: true });
  });

  it('marks the current gate from missing required artifacts', () => {
    const summary = buildTrackGateReadinessSummary({
      track: {
        track_id: 'TRK-SDLC-1',
        project_id: 'PRJ-SDLC-1',
        name: 'Primary Delivery',
        summary: 'Main delivery lane',
        status: 'active',
        track_type: 'delivery',
        lifecycle_model: 'sdlc',
        tier: 'public',
      },
      artifacts: [
        {
          artifact_id: 'ART-REQ-1',
          project_id: 'PRJ-SDLC-1',
          track_id: 'TRK-SDLC-1',
          kind: 'requirements-definition',
          storage_class: 'repo',
        },
        {
          artifact_id: 'ART-RTM-1',
          project_id: 'PRJ-SDLC-1',
          track_id: 'TRK-SDLC-1',
          kind: 'requirements-traceability-matrix',
          storage_class: 'repo',
        },
      ],
    });

    expect(summary.total_gate_count).toBeGreaterThan(0);
    expect(summary.current_gate_id).toBe('gate-requirements-baseline');
    expect(summary.current_phase).toBe('define');
    expect(summary.gates[0]?.present_artifacts).toEqual(['requirements-definition', 'requirements-traceability-matrix']);
    expect(summary.next_required_artifacts[0]?.artifact_id).toBe('slo-sli-definition');
    expect(summary.next_required_artifacts[0]?.template_ref).toBe('knowledge/public/templates/blueprints/slo-sli-definition.md');
  });

  it('creates a deterministic next-work proposal from missing artifacts', () => {
    const readiness = buildTrackGateReadinessSummary({
      track: {
        track_id: 'TRK-SDLC-2',
        project_id: 'PRJ-SDLC-2',
        name: 'Release 2',
        summary: 'Release lane',
        status: 'active',
        track_type: 'release',
        lifecycle_model: 'sdlc',
        tier: 'public',
      },
      artifacts: [],
    });

    const proposal = buildTrackNextWorkProposal({
      project: {
        project_id: 'PRJ-SDLC-2',
        name: 'Payments Modernization',
        summary: 'Project',
        status: 'active',
        tier: 'public',
      },
      track: {
        track_id: 'TRK-SDLC-2',
        project_id: 'PRJ-SDLC-2',
        name: 'Release 2',
        summary: 'Release lane',
        status: 'active',
        track_type: 'release',
        lifecycle_model: 'sdlc',
        tier: 'public',
      },
      readiness,
    });

    expect(proposal?.seed_id).toBe('MSD-TRK-SDLC-2-REQUIREMENTS-DEFINITION');
    expect(proposal?.target_path).toBe('tracks/TRK-SDLC-2/02_define/requirements-definition.md');
    expect(proposal?.work_loop.context?.track_id).toBe('TRK-SDLC-2');
    expect(proposal?.work_loop.outcome_design?.outcome_ids).toEqual(['requirements-definition']);
  });

  it('materializes a blueprint skeleton into the governed project root', () => {
    const readiness = buildTrackGateReadinessSummary({
      track: {
        track_id: 'TRK-SDLC-3',
        project_id: 'PRJ-SDLC-3',
        name: 'Release 3',
        summary: 'Release lane',
        status: 'active',
        track_type: 'release',
        lifecycle_model: 'sdlc',
        tier: 'public',
      },
      artifacts: [],
    });

    const proposal = buildTrackNextWorkProposal({
      project: {
        project_id: 'PRJ-SDLC-3',
        name: 'Payments Modernization',
        summary: 'Project',
        status: 'active',
        tier: 'public',
      },
      track: {
        track_id: 'TRK-SDLC-3',
        project_id: 'PRJ-SDLC-3',
        name: 'Release 3',
        summary: 'Release lane',
        status: 'active',
        track_type: 'release',
        lifecycle_model: 'sdlc',
        tier: 'public',
      },
      readiness,
    });

    const logicalPath = materializeTrackArtifactSkeleton({
      projectRootPath: 'active/projects/test-sdlc-skeleton',
      proposal: proposal!,
    });
    const resolvedPath = pathResolver.resolve(`active/projects/test-sdlc-skeleton/${logicalPath}`);
    expect(logicalPath).toBe('tracks/TRK-SDLC-3/02_define/requirements-definition.md');
    expect(safeExistsSync(resolvedPath)).toBe(true);
    expect(String(safeReadFile(resolvedPath, { encoding: 'utf8' }) || '')).toContain('Instantiated from knowledge/public/templates/blueprints/requirements-definition.md');
  });
});
