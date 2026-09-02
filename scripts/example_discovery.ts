import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import chalk from 'chalk';
import { isRecord } from '@agent/core/foundation';
import {
  loadActuatorExampleCatalog,
  type ActuatorExampleCatalog,
} from '@agent/core/src/actuator-example-catalog';
import { defineScript, isDirectScript } from './lib/harness.js';

export function isActuatorExampleCatalog(value: unknown): value is ActuatorExampleCatalog {
  if (!isRecord(value) || typeof value.actuator !== 'string' || !Array.isArray(value.examples)) {
    return false;
  }
  return value.examples.every(
    (example) =>
      isRecord(example) &&
      typeof example.id === 'string' &&
      typeof example.title === 'string' &&
      typeof example.path === 'string' &&
      typeof example.description === 'string' &&
      (example.tags === undefined ||
        (Array.isArray(example.tags) && example.tags.every((tag) => typeof tag === 'string')))
  );
}

function loadCatalogs(): ActuatorExampleCatalog[] {
  const actuatorsDir = assertSafeRepositoryPath(pathResolver.rootResolve('libs/actuators'));
  return safeReaddir(actuatorsDir)
    .map((entry) => {
      try {
        return assertSafeRepositoryPath(
          path.join(actuatorsDir, entry, 'examples', 'catalog.json'),
          { allowMissingLeaf: false }
        );
      } catch {
        return null;
      }
    })
    .filter((catalogPath): catalogPath is string => Boolean(catalogPath))
    .filter((catalogPath) => safeExistsSync(catalogPath) && safeLstat(catalogPath).isFile())
    .map((catalogPath) => {
      try {
        return loadActuatorExampleCatalog(catalogPath);
      } catch {
        return null;
      }
    })
    .filter(isActuatorExampleCatalog)
    .sort((left, right) => left.actuator.localeCompare(right.actuator));
}

export function renderCatalogs(catalogs: readonly ActuatorExampleCatalog[]): string {
  const lines = [chalk.bold.cyan('\n🧪 [KYBERION] Actuator Example Discovery\n')];

  if (catalogs.length === 0) {
    return `${lines.join('')}No actuator-owned examples found.`;
  }

  for (const catalog of catalogs) {
    lines.push(`${chalk.bold.white(catalog.actuator)} (${catalog.examples.length})`);
    for (const example of catalog.examples) {
      lines.push(`  - ${chalk.bold(example.id)}: ${example.title}`);
      lines.push(`    ${example.description}`);
      lines.push(`    ${chalk.gray(example.path)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const runExampleDiscovery = defineScript({
  name: 'examples',
  flags: ['json', 'quiet'],
  run(context) {
    const catalogs = loadCatalogs();
    context.print(context.json ? { status: 'ok', catalogs } : renderCatalogs(catalogs));
    return catalogs;
  },
});

if (
  isDirectScript(import.meta.url, 'example_discovery.ts') ||
  isDirectScript(import.meta.url, 'example_discovery.js')
)
  void runExampleDiscovery();
