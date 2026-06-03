import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import Ajv from 'ajv';
import { safeReadFile, safeReaddir } from '@agent/core';

const rootDir = process.cwd();
function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

const PRESET_DIR = 'knowledge/product/config-missions';
const PIPELINE_CONFIG_DIR = 'pipelines/config';

describe('Config mission contract', () => {
  it('preset schema is valid JSON Schema', () => {
    const schema = JSON.parse(read('schemas/config-mission-preset.schema.json'));
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.required).toContain('preset_id');
    expect(schema.required).toContain('inputs');
    expect(schema.required).toContain('write_targets');
    expect(schema.required).toContain('authority_role');
  });

  it('all presets conform to the schema', () => {
    const schema = JSON.parse(read('schemas/config-mission-preset.schema.json'));
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);

    const files = (safeReaddir(path.join(rootDir, PRESET_DIR)) as string[])
      .filter(f => f.endsWith('.json'));

    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const preset = JSON.parse(read(path.join(PRESET_DIR, file)));
      const valid = validate(preset);
      expect(valid, `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('each preset references an existing pipeline', () => {
    const files = (safeReaddir(path.join(rootDir, PRESET_DIR)) as string[])
      .filter(f => f.endsWith('.json'));

    for (const file of files) {
      const preset = JSON.parse(read(path.join(PRESET_DIR, file)));
      const pipelineRaw = safeReadFile(path.join(rootDir, preset.pipeline), { encoding: 'utf8' });
      expect(pipelineRaw, `Pipeline missing for preset ${preset.preset_id}: ${preset.pipeline}`).toBeTruthy();
    }
  });

  it('each preset declares authority_role as system_configurator', () => {
    const files = (safeReaddir(path.join(rootDir, PRESET_DIR)) as string[])
      .filter(f => f.endsWith('.json'));

    for (const file of files) {
      const preset = JSON.parse(read(path.join(PRESET_DIR, file)));
      expect(preset.authority_role, `${file} should use system_configurator`).toBe('system_configurator');
    }
  });

  it('system_configurator is defined in security-policy authority_role_permissions', () => {
    const policy = JSON.parse(read('knowledge/product/governance/security-policy.json'));
    const sc = policy.authority_role_permissions?.system_configurator;
    expect(sc).toBeDefined();
    expect(sc.allow_read).toContain('knowledge/product/config-missions/');
    expect(sc.allow_write).toContain('knowledge/confidential/');
    expect(sc.allow_write).toContain('knowledge/product/governance/service-presets/');
  });

  it('system_configurator authority-role file exists and is well-formed', () => {
    const ar = JSON.parse(read('knowledge/product/governance/authority-roles/system_configurator.json'));
    expect(ar.role).toBe('system_configurator');
    expect(ar.default_persona).toBe('worker');
    expect(ar.write_scopes).toContain('knowledge/confidential/');
  });

  it('config-mission script is registered in package.json with correct persona', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const script = pkg.scripts['config-mission'];
    expect(script).toBeDefined();
    expect(script).toContain('KYBERION_PERSONA=worker');
    expect(script).toContain('SYSTEM_ROLE=system_configurator');
    expect(script).toContain('config_mission.js');
  });

  it('config pipeline files are valid pipeline ADF', () => {
    const files = (safeReaddir(path.join(rootDir, PIPELINE_CONFIG_DIR)) as string[])
      .filter(f => f.endsWith('.json'));

    expect(files.length).toBeGreaterThanOrEqual(4);

    for (const file of files) {
      const pipeline = JSON.parse(read(path.join(PIPELINE_CONFIG_DIR, file)));
      expect(pipeline.action, `${file} missing action`).toBe('pipeline');
      expect(Array.isArray(pipeline.steps), `${file} missing steps`).toBe(true);
      expect(pipeline.steps.length, `${file} has no steps`).toBeGreaterThan(0);
    }
  });

  it('config_mission.ts CLI script exists and exports expected commands', () => {
    const src = read('scripts/config_mission.ts');
    expect(src).toContain("case 'list'");
    expect(src).toContain("case 'create'");
    expect(src).toContain("case 'status'");
    expect(src).toContain("case 'apply'");
    expect(src).toContain('SYSTEM_ROLE=system_configurator');
    expect(src).toContain('knowledge/product/config-missions');
    expect(src).toContain('knowledge/confidential');
  });
});
