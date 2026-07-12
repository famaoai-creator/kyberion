import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
} from './index.js';

// AR-02: the guide op tables now cover every actuator (generated from the
// discovery index) with an "Actuators" owner column. This test keeps the
// system actuator's rows aligned with its exported constants.
function extractOps(sectionHeading: string): string[] {
  const guide = String(
    safeReadFile(pathResolver.rootResolve('CAPABILITIES_GUIDE.md'), { encoding: 'utf8' }) || ''
  );
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === sectionHeading);
  expect(start, `missing section heading ${sectionHeading}`).toBeGreaterThanOrEqual(0);

  const ops: string[] = [];
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('|')) break;
    if (line.includes('| Op |') || line.includes(':---')) continue;
    const cells = line.split('|').slice(1, 3);
    const owners = (cells[1] || '').split(',').map((owner) => owner.trim());
    if (!owners.includes('system')) continue;
    const matches = Array.from(cells[0].matchAll(/`([^`]+)`/g), (match) => match[1]);
    ops.push(...matches);
  }
  return ops;
}

describe('system-actuator op catalog', () => {
  it('keeps capture ops aligned with the published guide', () => {
    expect(extractOps('### Capture ops (type: capture)').sort()).toEqual(
      [...SYSTEM_ACTUATOR_CAPTURE_OPS].sort()
    );
  });

  it('keeps transform ops aligned with the published guide', () => {
    expect(extractOps('### Transform ops (type: transform)').sort()).toEqual(
      [...SYSTEM_ACTUATOR_TRANSFORM_OPS].sort()
    );
  });

  it('keeps apply ops aligned with the published guide', () => {
    expect(extractOps('### Apply ops (type: apply)').sort()).toEqual(
      [...SYSTEM_ACTUATOR_APPLY_OPS].sort()
    );
  });

  it('keeps control ops aligned with the published guide', () => {
    expect(extractOps('### Control ops (type: control)').sort()).toEqual(
      [...SYSTEM_ACTUATOR_CONTROL_OPS].sort()
    );
  });

  it('keeps the contract schema aligned with routed public ops', () => {
    const schema = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve('schemas/system-pipeline.schema.json'), {
          encoding: 'utf8',
        }) || '{}'
      )
    );
    const enumValues = new Set<string>(
      schema?.properties?.steps?.items?.properties?.op?.enum || []
    );
    const bareOps = [
      ...SYSTEM_ACTUATOR_CAPTURE_OPS,
      ...SYSTEM_ACTUATOR_TRANSFORM_OPS,
      ...SYSTEM_ACTUATOR_APPLY_OPS,
      ...SYSTEM_ACTUATOR_CONTROL_OPS,
    ];

    for (const op of bareOps) {
      expect(enumValues.has(op), `schema missing ${op}`).toBe(true);
      expect(enumValues.has(`system:${op}`), `schema missing system:${op}`).toBe(true);
    }
    expect(enumValues.has('core:if')).toBe(true);
    expect(enumValues.has('core:while')).toBe(true);
    expect(schema?.properties?.steps?.items?.properties?.type?.enum).toContain('control');
  });
});
