import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

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
  });
});
