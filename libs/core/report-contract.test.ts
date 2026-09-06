import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { executeReportContract } from './report-contract.js';

describe('pipeline report contract', () => {
  const schemaLink = pathResolver.knowledge('product/schemas/report-contract-test.json');
  const externalSchema = pathResolver.sharedTmp('report-contract-test.json');

  afterEach(() => {
    const savedPersona = process.env.KYBERION_PERSONA;
    const savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      safeRmSync(schemaLink, { recursive: true, force: true });
      safeRmSync(externalSchema, { recursive: true, force: true });
    } finally {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    }
  });

  it('validates a report after the perform phase', async () => {
    let calls = 0;
    const result = await executeReportContract(
      {
        delegateTask: async () => {
          calls += 1;
          return calls === 1 ? '{"approve":"yes"}' : '{"approve":true,"gaps":[]}';
        },
      },
      { schema_ref: 'planning_review_verdict', use_judge: true },
      'Report the completed operation.'
    );

    expect(result).toEqual({ approve: true, gaps: [] });
    expect(calls).toBe(2);
  });

  it('rejects schema references outside the product schema boundary', async () => {
    await expect(
      executeReportContract(
        { delegateTask: async () => '{}' },
        { schema_ref: '../secret.json' },
        'Report the completed operation.'
      )
    ).rejects.toThrow(/REPORT_SCHEMA_INVALID/);
  });

  it('rejects a product schema leaf replaced by a symlink', async () => {
    const savedPersona = process.env.KYBERION_PERSONA;
    const savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      safeWriteFile(externalSchema, JSON.stringify({ type: 'object' }));
      safeSymlinkSync(externalSchema, schemaLink, 'file');

      await expect(
        executeReportContract(
          { delegateTask: async () => '{}' },
          { schema_ref: 'report-contract-test.json' },
          'Report the completed operation.'
        )
      ).rejects.toThrow(/RESOURCE_PATH_SYMLINK/);
    } finally {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    }
  });
});
