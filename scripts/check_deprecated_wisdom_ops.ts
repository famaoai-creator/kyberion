import * as path from 'node:path';
import { describeOps } from '../libs/actuators/wisdom-actuator/src/op-catalog.js';
import { getAllFiles } from '../libs/core/fs-utils.js';
import { pathResolver, safeExistsSync, safeReadFile } from '../libs/core/index.js';

const DEPRECATED = new Map(
  describeOps()
    .filter((entry) => entry.deprecated && entry.canonical_op)
    .map((entry) => [entry.op, entry.canonical_op as string])
);
const FORWARDED = new Map(
  describeOps()
    .filter((entry) => entry.forward_to)
    .map((entry) => [entry.op, `${entry.forward_to!.actuator}:${entry.forward_to!.op}`])
);

const ROOTS = [
  pathResolver.rootResolve('pipelines'),
  pathResolver.rootResolve('knowledge/product/pipeline-templates'),
];

type Finding = {
  file: string;
  op: string;
  canonical: string;
  kind: 'deprecated_alias' | 'compatibility_forwarder';
};

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
            op: alias,
            canonical,
            kind: 'deprecated_alias',
          });
        }
      }
      for (const [op, canonical] of FORWARDED) {
        if (content.includes(`wisdom:${op}`)) {
          findings.push({
            file: path.relative(pathResolver.rootDir(), file),
            op,
            canonical,
            kind: 'compatibility_forwarder',
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
      `[check:deprecated-wisdom-ops] ${finding.file}: wisdom:${finding.op} -> ${finding.canonical} (${finding.kind})`
    );
  }
  if (process.argv.includes('--fail')) process.exitCode = 1;
}
