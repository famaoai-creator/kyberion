import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeRmSync, saveProjectRecord, saveProjectTrackRecord } from '@agent/core';
import {
  assertCanGrantMissionAuthority,
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  resolveMissionStartCreateInputFromArgv,
  validateMissionStartCreateInput,
} from './mission_controller.js';

describe('mission_controller argument parsing', () => {
  beforeEach(() => {
    safeRmSync(pathResolver.shared('runtime/project-registry/PRJ-TEST-AUTO-TRACK.json'), {
      force: true,
    });
    safeRmSync(pathResolver.shared('runtime/project-tracks/TRK-TEST-AUTO-TRACK.json'), {
      force: true,
    });
  });

  it('removes project traceability flags and their values from positional arguments', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-1',
      'confidential',
      'default',
      'development',
      'vision-ref',
      'persona',
      '{}',
      '--project-id',
      'PROJ-1',
      '--project-path',
      'projects/sample',
      '--project-relationship',
      'supports',
      '--affected-artifacts',
      'a.md,b.md',
      '--gate-impact',
      'review_required',
      '--traceability-refs',
      'ADR-1,TEST-9',
      '--project-note',
      'linked mission',
      '--refresh',
    ]);

    expect(positionalArgs).toEqual([
      'start',
      'MSN-1',
      'confidential',
      'default',
      'development',
      'vision-ref',
      'persona',
      '{}',
    ]);
  });

  it('removes boolean execution flags without disturbing positional arguments', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'finish',
      'MSN-2',
      '--seal',
      '--execute',
    ]);

    expect(positionalArgs).toEqual(['finish', 'MSN-2']);
  });

  it('treats --dry-run as a boolean flag instead of a positional argument', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-2B',
      '--dry-run',
    ]);

    expect(positionalArgs).toEqual(['start', 'MSN-2B']);
  });

  it('treats checkpoint --mission-id as a named option instead of a positional argument', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'checkpoint',
      '--mission-id',
      'MSN-2C',
      'step-1',
      'Progress note',
    ]);

    expect(positionalArgs).toEqual(['checkpoint', 'step-1', 'Progress note']);
  });

  it('treats record-evidence metadata options as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'record-evidence',
      'MSN-2D',
      'review',
      'Evidence recorded',
      '--team-role',
      'reviewer',
      '--actor-id',
      'implementation-architect',
      '--actor-type',
      'agent',
      '--evidence',
      'evidence/report.json,evidence/screenshot.png',
    ]);

    expect(positionalArgs).toEqual(['record-evidence', 'MSN-2D', 'review', 'Evidence recorded']);
  });

  it('treats memory queue control options as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'memory-promote',
      'MEM-123',
      '--execution-role',
      'chronos_gateway',
      '--note',
      'operator approved',
    ]);

    expect(positionalArgs).toEqual(['memory-promote', 'MEM-123']);
  });

  it('treats memory bulk promotion flags as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'memory-promote-pending',
      '--execution-role',
      'mission_controller',
      '--note',
      'batch approval',
      '--dry-run',
    ]);

    expect(positionalArgs).toEqual(['memory-promote-pending']);
  });

  it('extracts project relationship options into a normalized relationship payload', () => {
    const relationships = extractProjectRelationshipOptionsFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-3',
      '--project-id',
      'PROJ-9',
      '--project-path',
      'projects/os-sample',
      '--project-relationship',
      'governs',
      '--affected-artifacts',
      '04_control/mission-ledger.md,04_control/mission-ledger.json',
      '--gate-impact',
      'blocking',
      '--traceability-refs',
      'ADR-9,TEST-22',
      '--project-note',
      'critical governance linkage',
    ]);

    expect(relationships).toEqual({
      project: {
        relationship_type: 'governs',
        project_id: 'PROJ-9',
        project_path: 'projects/os-sample',
        affected_artifacts: ['04_control/mission-ledger.md', '04_control/mission-ledger.json'],
        gate_impact: 'blocking',
        traceability_refs: ['ADR-9', 'TEST-22'],
        note: 'critical governance linkage',
      },
    });
  });

  it('returns an empty relationship object when no project flags are present', () => {
    const relationships = extractProjectRelationshipOptionsFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'status',
      'MSN-4',
    ]);

    expect(relationships).toEqual({});
  });

  it('treats --relationships as a named option instead of a positional argument', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-5',
      '--relationships',
      '{"project":{"project_id":"PRJ-1","project_path":"projects/sample","relationship_type":"belongs_to"}}',
      '--persona',
      'Ecosystem Architect',
    ]);

    expect(positionalArgs).toEqual(['start', 'MSN-5']);
  });

  it('treats --routing-decision as a named option instead of a positional argument', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-5B',
      '--routing-decision',
      '{"kind":"agent-routing-decision","intent_id":"generate-report"}',
      '--persona',
      'Ecosystem Architect',
    ]);

    expect(positionalArgs).toEqual(['start', 'MSN-5B']);
  });

  it('extracts named mission start/create options safely', () => {
    const options = extractMissionStartCreateOptionsFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-6',
      '--tier',
      'public',
      '--persona',
      'Ecosystem Architect',
      '--mission-type',
      'development',
      '--relationships',
      '{"project":{"project_id":"PRJ-1","project_path":"projects/sample","relationship_type":"belongs_to"}}',
      '--routing-decision',
      '{"kind":"agent-routing-decision","intent_id":"generate-report","mode":"subagent","owner":"document-specialist"}',
    ]);

    expect(options.tier).toBe('public');
    expect(options.persona).toBe('Ecosystem Architect');
    expect(options.missionType).toBe('development');
    expect(options.routingDecision).toContain('"mode":"subagent"');
    expect(options.relationships).toEqual({
      project: {
        project_id: 'PRJ-1',
        project_path: 'projects/sample',
        relationship_type: 'belongs_to',
      },
    });
  });

  it('extracts track relationship options alongside project options', () => {
    const options = extractMissionStartCreateOptionsFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-6B',
      '--project-id',
      'PRJ-1',
      '--project-path',
      'active/projects/sample',
      '--track-id',
      'TRK-REL-1',
      '--track-name',
      'Release 1',
      '--track-type',
      'release',
      '--lifecycle-model',
      'default-sdlc',
      '--track-relationship',
      'belongs_to',
      '--track-traceability-refs',
      'GATE-RR,REL-1',
      '--track-note',
      'release lane',
    ]);

    expect(options.relationships).toEqual({
      project: {
        project_id: 'PRJ-1',
        project_path: 'active/projects/sample',
        relationship_type: 'independent',
        affected_artifacts: [],
        gate_impact: 'none',
        traceability_refs: [],
        note: undefined,
      },
      track: {
        track_id: 'TRK-REL-1',
        track_name: 'Release 1',
        track_type: 'release',
        lifecycle_model: 'default-sdlc',
        relationship_type: 'belongs_to',
        traceability_refs: ['GATE-RR', 'REL-1'],
        note: 'release lane',
      },
    });
  });

  it('resolves normalized ledger targets for linked missions', () => {
    const input = resolveMissionStartCreateInputFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-7',
      '--tier',
      'public',
      '--project-id',
      'PRJ-2',
      '--project-path',
      'projects/sample',
      '--project-relationship',
      'supports',
    ]);

    expect(input.relationships?.project?.project_path).toBe('projects/sample');
    expect(
      input.ledgerTargets?.markdown.endsWith('projects/sample/04_control/mission-ledger.md')
    ).toBe(true);
    expect(
      input.ledgerTargets?.json.endsWith('projects/sample/04_control/mission-ledger.json')
    ).toBe(true);
  });

  it('inherits the project default track when project linkage is provided without explicit track flags', () => {
    saveProjectTrackRecord({
      track_id: 'TRK-TEST-AUTO-TRACK',
      project_id: 'PRJ-TEST-AUTO-TRACK',
      name: 'Primary Delivery',
      summary: 'Default delivery lane',
      status: 'active',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      tier: 'public',
    });
    saveProjectRecord({
      project_id: 'PRJ-TEST-AUTO-TRACK',
      name: 'Auto Track Project',
      summary: 'Project with default track',
      status: 'active',
      tier: 'public',
      default_track_id: 'TRK-TEST-AUTO-TRACK',
      active_tracks: ['TRK-TEST-AUTO-TRACK'],
    });

    const input = resolveMissionStartCreateInputFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-7B',
      '--tier',
      'public',
      '--project-id',
      'PRJ-TEST-AUTO-TRACK',
      '--project-path',
      'active/projects/sample',
      '--project-relationship',
      'belongs_to',
    ]);

    expect(input.relationships?.track).toEqual({
      relationship_type: 'belongs_to',
      track_id: 'TRK-TEST-AUTO-TRACK',
      track_name: 'Primary Delivery',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      traceability_refs: [],
    });
  });

  it('fails fast when a linked project path is not writable for the current authority', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    process.env.KYBERION_SUDO = 'false';

    expect(() =>
      validateMissionStartCreateInput('start', 'MSN-8', [
        'node',
        'dist/scripts/mission_controller.js',
        'start',
        'MSN-8',
        '--project-id',
        'PRJ-3',
        '--project-path',
        'libs/core',
        '--project-relationship',
        'governs',
      ])
    ).toThrow("project ledger target 'libs/core/04_control/mission-ledger.md' is not writable");
  });

  it('requires a project relationship when track linkage is provided', () => {
    expect(() =>
      validateMissionStartCreateInput('start', 'MSN-8B', [
        'node',
        'dist/scripts/mission_controller.js',
        'start',
        'MSN-8B',
        '--track-id',
        'TRK-REL-2',
      ])
    ).toThrow('start MSN-8B: --track-id requires --project-id');
  });

  it('requires sudo authority before granting mission access', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    process.env.KYBERION_SUDO = 'false';

    expect(() => assertCanGrantMissionAuthority()).toThrow('Sudo authority is required');
  });

  it('allows grant flows when the caller has sudo authority', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_SUDO = 'true';

    expect(() => assertCanGrantMissionAuthority()).not.toThrow();
  });
});
