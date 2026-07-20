import * as path from 'node:path';
import { describeOps } from '../libs/actuators/wisdom-actuator/src/op-catalog.js';
import { getAllFiles } from '../libs/core/fs-utils.js';
import { pathResolver, safeExistsSync, safeReadFile } from '../libs/core/index.js';

const DEPRECATED = new Map(
  describeOps()
    .filter((entry) => entry.deprecated && entry.canonical_op)
    .map((entry) => [entry.op, entry.canonical_op as string])
);

const ROOTS = [
  pathResolver.rootResolve('pipelines'),
  pathResolver.rootResolve('knowledge/product/pipeline-templates'),
];

type Finding = { file: string; alias: string; canonical: string };

function collectFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const root of ROOTS) {
    if (!safeExistsSync(root)) continue;
    for (const file of getAllFiles(root).filter((entry) => entry.endsWith('.json'))) {
      const content = String(safeReadFile(file, { encoding: 'utf8' }));
      for (const [alias, canonical] of DEPRECATED) {
        if (content.includes(`wisdom:${alias}`)) {
          findings.push({
            file: path.relative(pathResolver.rootDir(), file),
            alias,
            canonical,
          });
        }
      }
    }
  }
  return findings;
}

const findings = collectFindings();
if (findings.length === 0) {
  console.log('[check:deprecated-wisdom-ops] OK (no deprecated Wisdom ops in catalogs)');
} else {
  for (const finding of findings) {
    console.warn(
      `[check:deprecated-wisdom-ops] ${finding.file}: wisdom:${finding.alias} -> wisdom:${finding.canonical}`
    );
  }
  if (process.argv.includes('--fail')) process.exitCode = 1;
}
