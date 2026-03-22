import { describe, expect, it } from 'vitest';
import { assertCanGrantMissionAuthority, extractMissionControllerPositionalArgs, extractProjectRelationshipOptionsFromArgv } from './mission_controller.js';

describe('mission_controller argument parsing', () => {
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

  it('requires sudo authority before granting mission access', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    process.env.KYBERION_SUDO = 'false';

    expect(() => assertCanGrantMissionAuthority()).toThrow('Sudo authority is required');
  });

  it('allows grant flows when the caller has sudo authority', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    delete process.env.KYBERION_SUDO;

    expect(() => assertCanGrantMissionAuthority()).not.toThrow();
  });
});
