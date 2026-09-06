import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { loadProjectMissionLedger } from './orchestrator-execution-brief-helpers.js';

const TEST_ROOT = pathResolver.sharedTmp(`orchestrator-project-ledger-${process.pid}`);
const TEST_LEDGER = `${TEST_ROOT}/mission-ledger.json`;

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('orchestrator execution brief catalog boundary', () => {
  it('loads request archetypes through the governed catalog schema', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'libs/actuators/orchestrator-actuator/src/orchestrator-execution-brief-helpers.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('defineCatalog<ActuatorRequestArchetypeCatalog>({');
    expect(source).toContain("id: 'actuator-request-archetypes'");
    expect(source).toContain('schema: ACTUATOR_ARCHETYPES_SCHEMA_PATH');
    expect(source).toContain('actuatorRequestArchetypeCatalog.load()');
    expect(source).toContain('parseSafeJsonObjectValue(');
    expect(source).toContain('readJson(templateFullPath)');
  });

  it('loads project ledgers through the governed schema boundary', () => {
    safeWriteFile(
      TEST_LEDGER,
      JSON.stringify({
        project_id: 'project-1',
        entries: [
          {
            mission_id: 'MSN-1',
            relationship_type: 'belongs_to',
            status: 'active',
            summary: 'active mission',
          },
        ],
      })
    );

    expect(loadProjectMissionLedger(TEST_LEDGER).entries).toHaveLength(1);
  });

  it('rejects malformed project ledgers before the status read model uses them', () => {
    safeWriteFile(TEST_LEDGER, JSON.stringify({ project_id: 'project-1', entries: [{}] }));

    expect(() => loadProjectMissionLedger(TEST_LEDGER)).toThrow(
      /Invalid catalog project-mission-ledger/
    );
  });

  it('rejects project ledger paths outside the repository', () => {
    expect(() => loadProjectMissionLedger('../mission-ledger.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
