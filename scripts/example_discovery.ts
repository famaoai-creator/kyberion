import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import chalk from 'chalk';

interface ActuatorExampleRecord {
  id: string;
  title: string;
  path: string;
  description: string;
  tags?: string[];
}

interface ActuatorExampleCatalog {
  actuator: string;
  examples: ActuatorExampleRecord[];
}

function loadCatalogs(): ActuatorExampleCatalog[] {
  const actuatorsDir = pathResolver.rootResolve('libs/actuators');
  return safeReaddir(actuatorsDir)
    .map((entry) => path.join(actuatorsDir, entry, 'examples', 'catalog.json'))
    .filter((catalogPath) => safeExistsSync(catalogPath))
    .map((catalogPath) => JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string) as ActuatorExampleCatalog)
    .sort((left, right) => left.actuator.localeCompare(right.actuator));
}

function printCatalogs(): void {
  const catalogs = loadCatalogs();
  console.log(chalk.bold.cyan('\n🧪 [KYBERION] Actuator Example Discovery\n'));

  if (catalogs.length === 0) {
    console.log('No actuator-owned examples found.');
    return;
  }

  for (const catalog of catalogs) {
    console.log(`${chalk.bold.white(catalog.actuator)} (${catalog.examples.length})`);
    for (const example of catalog.examples) {
      console.log(`  - ${chalk.bold(example.id)}: ${example.title}`);
      console.log(`    ${example.description}`);
      console.log(`    ${chalk.gray(example.path)}`);
    }
    console.log('');
  }
}

printCatalogs();
