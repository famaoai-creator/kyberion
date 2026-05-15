import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
} from './index.js';

function extractOps(sectionHeading: string): string[] {
  const guide = String(safeReadFile(pathResolver.rootResolve('CAPABILITIES_GUIDE.md'), { encoding: 'utf8' }) || '');
  const lines = guide.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === sectionHeading);
  expect(start, `missing section heading ${sectionHeading}`).toBeGreaterThanOrEqual(0);

  const ops: string[] = [];
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('|')) break;
    if (line.includes('| Op |')) continue;
    const [firstCell] = line.split('|').slice(1, 2);
    const matches = Array.from(firstCell.matchAll(/`([^`]+)`/g), (match) => match[1]);
    ops.push(...matches);
  }
  return ops;
}

describe('system-actuator op catalog', () => {
  it('keeps capture ops aligned with the published guide', () => {
    expect(extractOps('### Capture ops (type: capture)')).toEqual([...SYSTEM_ACTUATOR_CAPTURE_OPS]);
  });

  it('keeps transform ops aligned with the published guide', () => {
    expect(extractOps('### Transform ops (type: transform)')).toEqual([...SYSTEM_ACTUATOR_TRANSFORM_OPS]);
  });

  it('keeps apply ops aligned with the published guide', () => {
    expect(extractOps('### Apply ops (type: apply)')).toEqual([...SYSTEM_ACTUATOR_APPLY_OPS]);
  });

  it('keeps control ops aligned with the published guide', () => {
    expect(extractOps('### Control ops (type: control)')).toEqual([...SYSTEM_ACTUATOR_CONTROL_OPS]);
  });

  it('keeps the contract schema aligned with routed public ops', () => {
    const schema = JSON.parse(String(safeReadFile(pathResolver.rootResolve('schemas/system-pipeline.schema.json'), { encoding: 'utf8' }) || '{}'));
    const enumValues = new Set<string>(schema?.properties?.steps?.items?.properties?.op?.enum || []);
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
