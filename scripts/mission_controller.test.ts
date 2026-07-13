import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeReadFile,
  safeRmSync,
  saveProjectRecord,
  saveProjectTrackRecord,
} from '@agent/core';
import * as killSwitch from '@agent/core/kill-switch';
import {
  assertCanGrantMissionAuthority,
  extractMissionControllerPositionalArgs,
  extractMissionStartCreateOptionsFromArgv,
  extractProjectRelationshipOptionsFromArgv,
  buildHelpText,
  buildOrganizationDiscoveryReport,
  main,
  resolveMissionStartCreateInputFromArgv,
  validateMissionStartCreateInput,
} from './mission_controller.js';
import * as missionControllerRouter from './refactor/mission-controller-router.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

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

  it('treats --help and -h as boolean flags instead of positional arguments', () => {
    const longHelpArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-HELP',
      '--help',
    ]);
    const shortHelpArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-HELP',
      '-h',
    ]);

    expect(longHelpArgs).toEqual(['create', 'MSN-HELP']);
    expect(shortHelpArgs).toEqual(['create', 'MSN-HELP']);
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

  it('treats reconcile-work manifest and dry-run options as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'reconcile-work',
      'MSN-2E',
      '--manifest',
      'active/shared/tmp/reconciliation.json',
      '--dry-run',
    ]);

    expect(positionalArgs).toEqual(['reconcile-work', 'MSN-2E']);
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
      '--supersedes',
      'knowledge/public/common/wisdom/generated/OLD.md',
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
      '--supersedes',
      'knowledge/public/common/patterns/generated/OLD.md',
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

  it('starts kill-switch monitoring from the mission controller entrypoint', async () => {
    const startSpy = vi.spyOn(killSwitch.killSwitch, 'startMonitor');
    const routerSpy = vi
      .spyOn(missionControllerRouter, 'runMissionControllerAction')
      .mockResolvedValue(undefined as any);
    const originalArgv = process.argv.slice();
    process.argv = ['node', 'dist/scripts/mission_controller.js', 'help'];

    try {
      await main();
      expect(startSpy).toHaveBeenCalled();
      expect(routerSpy).toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      startSpy.mockRestore();
      routerSpy.mockRestore();
    }
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
      '--organization-id',
      'demo-org',
      '--relationships',
      '{"project":{"project_id":"PRJ-1","project_path":"projects/sample","relationship_type":"belongs_to"}}',
      '--routing-decision',
      '{"kind":"agent-routing-decision","intent_id":"generate-report","mode":"subagent","owner":"document-specialist"}',
    ]);

    expect(options.tier).toBe('public');
    expect(options.persona).toBe('Ecosystem Architect');
    expect(options.missionType).toBe('development');
    expect(options.organizationId).toBe('demo-org');
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

  it('resolves organization id from named mission input options', () => {
    const input = resolveMissionStartCreateInputFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'start',
      'MSN-9',
      '--tier',
      'confidential',
      '--organization-id',
      'demo-org',
      '--tenant-id',
      'tenant-a',
      '--mission-type',
      'operations',
    ]);

    expect(input.organizationId).toBe('demo-org');
    expect(input.tenantId).toBe('tenant-a');
    expect(input.tier).toBe('confidential');
    expect(input.missionType).toBe('operations');
  });

  it('accepts the short --org alias for organization id', () => {
    const options = extractMissionStartCreateOptionsFromArgv([
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-10',
      '--org',
      'demo-org',
    ]);

    expect(options.organizationId).toBe('demo-org');
  });

  it('includes the organization selection guide in the help text', () => {
    const help = buildHelpText();

    expect(help).toContain('Organization Selection:');
    expect(help).toContain('knowledge/product/orchestration/organization-selection-guide.md');
    expect(help).toContain('Organization Discovery:');
    expect(help).toContain('knowledge/product/orchestration/organization-discovery.md');
    expect(help).toContain('knowledge/product/orchestration/organization-discovery-reports.md');
    expect(help).toContain('--organization-id <ORG>');
    expect(help).toContain('--org <ORG>');
    expect(help).toContain('--summary');
    expect(help).toContain('organization-discovery [--json]');
    expect(help).toContain(
      'organization-catalogs [--json] [--organization-id <ORG>] [--selected-only] [--summary]'
    );
    expect(help).toContain(
      'organization-profiles [--json] [--organization-id <ORG>] [--active-only] [--ready-only] [--missing-only] [--source <customer|public>] [--summary]'
    );
    expect(help).toContain('organization-profile [--json] [--organization-id <ORG>] [--summary]');
    expect(help).toContain('organization-profiles --json --summary');
    expect(help).toContain('organization-profile --json --summary');
    expect(help).toContain('organization-catalogs --json --selected-only --summary');
    expect(help).toContain('reconcile-work <ID> --manifest <PATH> [--dry-run]');
    expect(help).toContain(
      'resume   [ID]                  Resume the last active mission and replay orchestration journal (or specify ID)'
    );
    expect(help).toContain(
      'scope-approve <ID> [--goal <TEXT>] [--reason <TEXT>]'
    );
  });

  it('treats --json as a boolean flag for organization profile inventory', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profiles',
      '--json',
    ]);

    expect(positionalArgs).toEqual(['organization-profiles']);
  });

  it('treats organization inventory organization selectors as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profiles',
      '--organization-id',
      'demo-org',
      '--json',
    ]);

    expect(positionalArgs).toEqual(['organization-profiles']);
  });

  it('treats organization discovery as a positional command with json as a boolean flag', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-discovery',
      '--json',
    ]);

    expect(positionalArgs).toEqual(['organization-discovery']);
  });

  it('dispatches organization discovery through the mission_controller main entrypoint', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'organization-discovery',
      '--json',
    ];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(output).toContain('"title": "Organization Discovery"');
      expect(output).toContain('"Organization Selection Guide"');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('emits clean JSON for organization profile inventory', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profiles',
      '--json',
    ];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(() => JSON.parse(output)).not.toThrow();
      const payload = JSON.parse(output);
      expect(payload).toHaveProperty('summary');
      expect(payload).toHaveProperty('profiles');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('emits clean JSON for organization discovery', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'organization-discovery',
      '--json',
    ];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(() => JSON.parse(output)).not.toThrow();
      const payload = JSON.parse(output);
      expect(payload).toHaveProperty('title', 'Organization Discovery');
      expect(payload).toHaveProperty('documents');
      expect(payload).toHaveProperty('examples');
      expect(payload).toHaveProperty('common_questions');
      expect(payload.documents).toHaveLength(3);
      expect(payload.examples).toHaveLength(4);
      expect(payload.common_questions).toHaveLength(4);
      expect(payload.examples.map((example: any) => example.name)).toEqual([
        'Organization Discovery Example',
        'Organization Profile Example',
        'Organization Profiles Example',
        'Organization Catalog Example',
      ]);
      expect(payload.examples.map((example: any) => example.path)).toEqual([
        'knowledge/product/schemas/organization-discovery-report.example.json',
        'knowledge/product/schemas/organization-profile-report.example.json',
        'knowledge/product/schemas/organization-profiles-report.example.json',
        'knowledge/product/schemas/organization-catalog-report.example.json',
      ]);
      expect(payload.examples.map((example: any) => example.schema)).toEqual([
        'knowledge/product/schemas/organization-discovery-report.schema.json',
        'knowledge/product/schemas/organization-profile-report.schema.json',
        'knowledge/product/schemas/organization-profiles-report.schema.json',
        'knowledge/product/schemas/organization-catalog-report.schema.json',
      ]);
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('emits canonical examples in the organization discovery text output', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = ['node', 'dist/scripts/mission_controller.js', 'organization-discovery'];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Canonical examples:');
      expect(output).toContain('Organization Discovery Example');
      expect(output).toContain('Organization Profiles Example');
      expect(output).toContain('organization-discovery-report.example.json');
      expect(output).toContain('organization-profile-report.example.json');
      expect(output).toContain('organization-profiles-report.example.json');
      expect(output).toContain('organization-catalog-report.example.json');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('emits clean JSON for organization profile detail', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = ['node', 'dist/scripts/mission_controller.js', 'organization-profile', '--json'];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(() => JSON.parse(output)).not.toThrow();
      const payload = JSON.parse(output);
      expect(payload).toHaveProperty('selected_catalog');
      expect(payload).toHaveProperty('profile');
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const profileSchema = JSON.parse(
        safeReadFile(pathResolver.knowledge('product/schemas/organization-profile.schema.json'), {
          encoding: 'utf8',
        }) as string
      );
      ajv.addSchema(
        profileSchema,
        'https://kyberion.local/schemas/organization-profile.schema.json'
      );
      const validate = ajv.compile(
        JSON.parse(
          safeReadFile(
            pathResolver.knowledge('product/schemas/organization-profile-report.schema.json'),
            { encoding: 'utf8' }
          ) as string
        )
      );
      expect(validate(payload), JSON.stringify(validate.errors || [])).toBe(true);
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('emits clean JSON for organization catalog inventory', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'organization-catalogs',
      '--json',
    ];

    try {
      await main();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(() => JSON.parse(output)).not.toThrow();
      const payload = JSON.parse(output);
      expect(payload).toHaveProperty('selected_catalog');
      expect(payload).toHaveProperty('catalogs');
      const ajv = new Ajv({ allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(
        JSON.parse(
          safeReadFile(
            pathResolver.knowledge('product/schemas/organization-catalog-report.schema.json'),
            { encoding: 'utf8' }
          ) as string
        )
      );
      expect(validate(payload), JSON.stringify(validate.errors || [])).toBe(true);
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('dispatches the compact organization discovery summary through the main entrypoint', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'organization-discovery',
      '--summary',
    ];

    try {
      await main();
      const output = [...logSpy.mock.calls, ...infoSpy.mock.calls].flat().join('\n');
      expect(output).toContain('Organization Discovery');
      expect(output).toContain('Organization Selection Guide');
      expect(output).toContain('Organization Discovery Reports');
      expect(output).toContain('Organization Discovery Copy/Paste');
      expect(output).toContain('Canonical examples:');
      expect(output).toContain('Organization Profiles Example');
      expect(output).not.toContain('Common questions:');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('builds the organization discovery report with the expected documents and questions', () => {
    const report = buildOrganizationDiscoveryReport();

    expect(report.title).toBe('Organization Discovery');
    expect(report.summary).toContain(
      'organization selection, inventory, and template overlay inspection'
    );
    expect(report.documents).toHaveLength(3);
    expect(report.documents.map((doc) => doc.name)).toEqual([
      'Organization Selection Guide',
      'Organization Discovery Reports',
      'Organization Discovery Copy/Paste',
    ]);
    expect(report.documents.map((doc) => doc.path)).toEqual([
      'knowledge/product/orchestration/organization-selection-guide.md',
      'knowledge/product/orchestration/organization-discovery-reports.md',
      'knowledge/product/orchestration/README.md',
    ]);
    expect(report.examples.map((example) => example.schema)).toEqual([
      'knowledge/product/schemas/organization-discovery-report.schema.json',
      'knowledge/product/schemas/organization-profile-report.schema.json',
      'knowledge/product/schemas/organization-profiles-report.schema.json',
      'knowledge/product/schemas/organization-catalog-report.schema.json',
    ]);
    expect(report.examples.map((example) => example.name)).toEqual([
      'Organization Discovery Example',
      'Organization Profile Example',
      'Organization Profiles Example',
      'Organization Catalog Example',
    ]);
    expect(report.examples.map((example) => example.path)).toEqual([
      'knowledge/product/schemas/organization-discovery-report.example.json',
      'knowledge/product/schemas/organization-profile-report.example.json',
      'knowledge/product/schemas/organization-profiles-report.example.json',
      'knowledge/product/schemas/organization-catalog-report.example.json',
    ]);
    expect(report.common_questions).toHaveLength(4);
    expect(report.common_questions.map((item) => item.question)).toEqual([
      'What organization is selected right now?',
      'Which customer orgs are missing a profile?',
      'Which team template overlays are active for this org?',
      'Which organization profiles are ready to use?',
    ]);
  });

  it('validates the organization discovery report against its schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        safeReadFile(
          pathResolver.knowledge('product/schemas/organization-discovery-report.schema.json'),
          { encoding: 'utf8' }
        ) as string
      )
    );

    expect(
      validate(buildOrganizationDiscoveryReport()),
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('accepts the canonical organization discovery example', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(
      JSON.parse(
        safeReadFile(
          pathResolver.knowledge('product/schemas/organization-discovery-report.schema.json'),
          { encoding: 'utf8' }
        ) as string
      )
    );
    const example = JSON.parse(
      safeReadFile(
        pathResolver.knowledge('product/schemas/organization-discovery-report.example.json'),
        { encoding: 'utf8' }
      ) as string
    );

    expect(validate(example), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('treats organization inventory filters as named options', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profiles',
      '--active-only',
      '--ready-only',
      '--missing-only',
      '--source',
      'customer',
    ]);

    expect(positionalArgs).toEqual(['organization-profiles']);
  });

  it('treats --missing-only as a boolean flag for organization inventory', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profiles',
      '--missing-only',
    ]);

    expect(positionalArgs).toEqual(['organization-profiles']);
  });

  it('treats --json as a boolean flag for organization catalog inventory', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-catalogs',
      '--json',
    ]);

    expect(positionalArgs).toEqual(['organization-catalogs']);
  });

  it('treats selected-only as a boolean flag for organization catalog inventory', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-catalogs',
      '--selected-only',
    ]);

    expect(positionalArgs).toEqual(['organization-catalogs']);
  });

  it('treats summary as a boolean flag for organization inventory commands', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-catalogs',
      '--summary',
    ]);

    expect(positionalArgs).toEqual(['organization-catalogs']);
  });

  it('parses organization profile compact summary flags without disturbing positional arguments', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profile',
      '--organization-id',
      'demo-org',
      '--summary',
    ]);

    expect(positionalArgs).toEqual(['organization-profile']);
  });

  it('treats --json as a boolean flag for organization profile detail output', () => {
    const positionalArgs = extractMissionControllerPositionalArgs([
      'node',
      'dist/scripts/mission_controller.js',
      'organization-profile',
      '--organization-id',
      'demo-org',
      '--json',
    ]);

    expect(positionalArgs).toEqual(['organization-profile']);
  });

  it('includes the selected catalog template ids in the organization profile summary text', () => {
    const help = buildHelpText();

    expect(help).toContain('--summary');
    expect(help).toContain('organization-profile');
    expect(help).toContain('organization-catalogs');
    expect(help).toContain('knowledge/product/schemas/organization-discovery-report.example.json');
    expect(help).toContain('knowledge/product/schemas/organization-profile-report.example.json');
    expect(help).toContain('knowledge/product/schemas/organization-profiles-report.example.json');
    expect(help).toContain('knowledge/product/schemas/organization-catalog-report.example.json');
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

  it('emits a redacted intent-track gate summary for project-linked dry runs', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-TEST-INTENT-DRY',
      '--dry-run',
      '--project-id',
      'PRJ-TEST-INTENT-DRY',
      '--project-path',
      'active/projects/sample',
      '--project-relationship',
      'belongs_to',
      '--intent-id',
      'request-feature-development',
      '--intent-confidence',
      '0.9',
    ];

    try {
      await main();
      const payload = JSON.parse(logSpy.mock.calls.flat().join('\n'));
      expect(payload.input.relationships.track.track_id).toBe('TRK-TEST-INTENT-DRY-DELIVERY');
      expect(payload.intentTrackGate.status).toBe('ready_to_provision');
      expect(payload.intentTrackGate.track_record.project_id).toBe('PRJ-TEST-INTENT-DRY');
      expect(payload.intentTrackGate.policy).toBeUndefined();
      expect(payload.intentTrackGate.effective_policy).toBeUndefined();
      expect(payload.intentTrackGate.track_record.metadata).toBeUndefined();
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('requires a project link when intent-to-track gating is requested', async () => {
    const originalArgv = process.argv;
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-TEST-INTENT-NO-PROJECT',
      '--dry-run',
      '--intent-id',
      'request-feature-development',
      '--intent-confidence',
      '0.9',
    ];

    try {
      await expect(main()).rejects.toThrow('--intent-id requires --project-id and --project-path');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('surfaces low-confidence intent-track gates unless explicitly confirmed', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-TEST-INTENT-LOW',
      '--dry-run',
      '--project-id',
      'PRJ-TEST-INTENT-LOW',
      '--project-path',
      'active/projects/sample',
      '--project-relationship',
      'belongs_to',
      '--intent-id',
      'request-feature-development',
      '--intent-confidence',
      '0.4',
    ];

    try {
      await main();
      const payload = JSON.parse(logSpy.mock.calls.flat().join('\n'));
      expect(payload.intentTrackGate.status).toBe('escalation_required');
      expect(payload.input.relationships.track).toBeUndefined();
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('allows low-confidence intent-track dry runs with explicit confirmation', async () => {
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.argv = [
      'node',
      'dist/scripts/mission_controller.js',
      'create',
      'MSN-TEST-INTENT-CONFIRMED',
      '--dry-run',
      '--project-id',
      'PRJ-TEST-INTENT-CONFIRMED',
      '--project-path',
      'active/projects/sample',
      '--project-relationship',
      'belongs_to',
      '--intent-id',
      'request-feature-development',
      '--intent-confidence',
      '0.4',
      '--confirm-intent-track',
      'human approved after triage',
    ];

    try {
      await main();
      const payload = JSON.parse(logSpy.mock.calls.flat().join('\n'));
      expect(payload.intentTrackGate.status).toBe('ready_to_provision');
      expect(payload.input.relationships.track.note).toContain('confirmed below threshold');
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
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
