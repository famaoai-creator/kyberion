import * as path from 'node:path';
import { describeOps } from '../libs/actuators/wisdom-actuator/src/op-catalog.js';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver, safeReadFile } from '@agent/core';

type PipelineKind = 'capture' | 'transform' | 'apply' | 'control';
type Registry = { domains: Record<string, Record<PipelineKind, string[]>> };

const registry = JSON.parse(
  String(
    safeReadFile(pathResolver.knowledge('product/governance/actuator-op-registry.json'), {
      encoding: 'utf8',
    })
  )
) as Registry;
const forwarders = describeOps()
  .filter((entry) => entry.forward_to)
  .map((entry) => ({
    source: entry.op,
    target: `${entry.forward_to!.actuator}:${entry.forward_to!.op}`,
    actuator: entry.forward_to!.actuator,
    op: entry.forward_to!.op,
  }));
const targets = new Map(forwarders.map((entry) => [`${entry.actuator}:${entry.op}`, entry]));
const errors: string[] = [];

for (const target of forwarders) {
  const domain = registry.domains[target.actuator];
  const kind = domain
    ? (Object.entries(domain).find(([, ops]) => ops.includes(target.op))?.[0] as
        | PipelineKind
        | undefined)
    : undefined;
  if (!kind) errors.push(`missing canonical target ${target.target} for wisdom:${target.source}`);
}

for (const root of ['pipelines', 'knowledge/product/pipeline-templates']) {
  for (const file of getAllFiles(pathResolver.rootResolve(root)).filter((entry) =>
    entry.endsWith('.json')
  )) {
    let document: unknown;
    try {
      document = JSON.parse(String(safeReadFile(file, { encoding: 'utf8' })));
    } catch {
      continue;
    }
    walkSteps(document, (step, location) => {
      const target = targets.get(String(step.op || ''));
      if (!target || (!step.role && !step.type)) return;
      const expected = findTargetKind(target);
      const actual = step.type || roleToKind(step.role);
      if (expected && actual && expected !== actual) {
        errors.push(
          `${path.relative(pathResolver.rootDir(), file)}${location}: ${step.op} declares ${actual}, canonical target is ${expected}`
        );
      }
    });
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[check:wisdom-forwarders] ${error}`);
  process.exitCode = 1;
} else {
  console.log('[check:wisdom-forwarders] OK (targets exist and pipeline kinds agree)');
}

function findTargetKind(target: { actuator: string; op: string }): PipelineKind | undefined {
  const domain = registry.domains[target.actuator];
  return domain
    ? (Object.entries(domain).find(([, ops]) => ops.includes(target.op))?.[0] as
        | PipelineKind
        | undefined)
    : undefined;
}

function roleToKind(role: unknown): PipelineKind | undefined {
  if (role === 'source') return 'capture';
  if (role === 'transform') return 'transform';
  if (role === 'sink') return 'apply';
  if (role === 'gate') return 'control';
  return undefined;
}

function walkSteps(
  value: unknown,
  callback: (step: Record<string, any>, location: string) => void,
  location = ''
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkSteps(item, callback, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.op === 'string') callback(record as Record<string, any>, location);
  for (const [key, child] of Object.entries(record)) {
    if (
      key === 'params' ||
      key === 'then' ||
      key === 'else' ||
      key === 'pipeline' ||
      key === 'steps'
    ) {
      walkSteps(child, callback, `${location}.${key}`);
    }
  }
}
