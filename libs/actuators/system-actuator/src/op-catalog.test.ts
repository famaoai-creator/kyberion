import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_CAPTURE_OPS,
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

  it('keeps apply ops aligned with the published guide', () => {
    expect(extractOps('### Apply ops (type: apply)')).toEqual([...SYSTEM_ACTUATOR_APPLY_OPS]);
  });

});
