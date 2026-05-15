import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import {
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
} from '../libs/actuators/system-actuator/src/index.js';
import { readJsonFile } from './refactor/cli-input.js';

interface CapabilityManifest {
  actuator_id: string;
  version: string;
  description: string;
  contract_schema?: string;
  capabilities: Array<{ op: string; platforms: string[] }>;
}

interface CurrentIndexRecord {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
  contract_schema?: string;
}

interface LegacyRecord {
  name: string;
  path: string;
  status: 'legacy-review';
  package_based: boolean;
  rationale: string;
}

const ACTUATORS_DIR = pathResolver.rootResolve('libs/actuators');
const CURRENT_INDEX_PATH = pathResolver.knowledge('public/orchestration/global_actuator_index.json');
const SKILL_INDEX_PATH = pathResolver.knowledge('public/orchestration/global_skill_index.json');
const LEGACY_INDEX_PATH = pathResolver.knowledge('public/orchestration/legacy_component_index.json');
const REPORT_PATH = pathResolver.knowledge('public/architecture/component-lifecycle-inventory.md');
const CAPABILITIES_GUIDE_PATH = pathResolver.rootResolve('CAPABILITIES_GUIDE.md');

const LEGACY_RATIONALES: Record<string, string> = {
  'daemon-actuator': 'Launchd-era runtime management overlaps with surface-runtime and managed process supervision.',
  'physical-bridge': 'Thin wrapper that shells into browser/system actuators and writes temp files instead of expressing the flow directly as ADF.',
};

function loadManifest(manifestPath: string): CapabilityManifest {
  return readJsonFile<CapabilityManifest>(manifestPath);
}

function collectComponentInventory() {
  const entries = safeReaddir(ACTUATORS_DIR).sort();
  const current: CurrentIndexRecord[] = [];
  const legacy: LegacyRecord[] = [];

  for (const entry of entries) {
    const actuatorPath = path.join(ACTUATORS_DIR, entry);
    if (!safeLstat(actuatorPath).isDirectory()) {
      continue;
    }
    const manifestPath = path.join(actuatorPath, 'manifest.json');
    const packagePath = path.join(actuatorPath, 'package.json');

    if (safeExistsSync(manifestPath)) {
      const manifest = loadManifest(manifestPath);
      current.push({
        n: manifest.actuator_id,
        path: path.posix.join('libs/actuators', entry),
        d: manifest.description,
        s: 'implemented',
        version: manifest.version,
        capability_count: manifest.capabilities.length,
        contract_schema: manifest.contract_schema,
      });
      continue;
    }

    legacy.push({
      name: entry,
      path: path.posix.join('libs/actuators', entry),
      status: 'legacy-review',
      package_based: safeExistsSync(packagePath),
      rationale: LEGACY_RATIONALES[entry] || 'Not manifest-backed, so it is invisible to runtime discovery and needs explicit retirement or migration review.',
    });
  }

  return { current, legacy };
}

function writeJsonArtifacts(current: CurrentIndexRecord[], legacy: LegacyRecord[]) {
  safeWriteFile(CURRENT_INDEX_PATH, JSON.stringify({
    v: '2.0.0',
    t: current.length,
    u: new Date().toISOString(),
    actuators: current,
  }, null, 2) + '\n');

  safeWriteFile(LEGACY_INDEX_PATH, JSON.stringify({
    v: '1.0.0',
    t: legacy.length,
    u: new Date().toISOString(),
    components: legacy,
  }, null, 2) + '\n');

  safeWriteFile(SKILL_INDEX_PATH, JSON.stringify({
    v: '3.0.0',
    t: current.length,
    u: new Date().toISOString(),
    s: current.map((entry) => ({
      n: entry.n,
      path: entry.path,
      d: entry.d,
      s: entry.s,
      version: entry.version,
      capability_count: entry.capability_count,
    })),
  }, null, 2) + '\n');
}

function buildCapabilitiesGuide(current: CurrentIndexRecord[]): string {
  const lines: string[] = [];
  lines.push('# Kyberion Capabilities Guide');
  lines.push('');
  lines.push(`Total Actuators: ${current.length}`);
  lines.push(`Last updated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('This guide is generated from `libs/actuators/*/manifest.json`. It is the human-readable counterpart to the compatibility snapshot `knowledge/public/orchestration/global_actuator_index.json`.');
  lines.push('');
  lines.push('Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.');
  lines.push('');
  lines.push('| Actuator | Description | Version | Ops | Contract Schema | Path |');
  lines.push('| :--- | :--- | :--- | :---: | :--- | :--- |');
  for (const actuator of current) {
    lines.push(`| \`${actuator.n}\` | ${actuator.d} | ${actuator.version} | ${actuator.capability_count} | \`${actuator.contract_schema || '-'}\` | \`${actuator.path}\` |`);
  }
  lines.push('');
  lines.push('### Capture ops (type: capture)');
  lines.push('');
  lines.push('| Op | Notes |');
  lines.push('| :--- | :--- |');
  for (const op of SYSTEM_ACTUATOR_CAPTURE_OPS) {
    lines.push(`| \`${op}\` | system-actuator capture op |`);
  }
  lines.push('');
  lines.push('### Transform ops (type: transform)');
  lines.push('');
  lines.push('| Op | Notes |');
  lines.push('| :--- | :--- |');
  for (const op of SYSTEM_ACTUATOR_TRANSFORM_OPS) {
    lines.push(`| \`${op}\` | system-actuator transform op |`);
  }
  lines.push('');
  lines.push('### Apply ops (type: apply)');
  lines.push('');
  lines.push('| Op | Notes |');
  lines.push('| :--- | :--- |');
  for (const op of SYSTEM_ACTUATOR_APPLY_OPS) {
    lines.push(`| \`${op}\` | system-actuator apply op |`);
  }
  lines.push('');
  lines.push('### Control ops (type: control)');
  lines.push('');
  lines.push('| Op | Notes |');
  lines.push('| :--- | :--- |');
  for (const op of SYSTEM_ACTUATOR_CONTROL_OPS) {
    lines.push(`| \`${op}\` | system-actuator control op |`);
  }
  lines.push('');
  lines.push('See also:');
  lines.push('');
  lines.push('- Source manifests: `libs/actuators/*/manifest.json`');
  lines.push(`- Compatibility snapshot: [global_actuator_index.json](/Users/famao/kyberion/${path.relative(pathResolver.rootDir(), CURRENT_INDEX_PATH)})`);
  lines.push(`- [legacy_component_index.json](/Users/famao/kyberion/${path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH)})`);
  lines.push(`- [component-lifecycle-inventory.md](/Users/famao/kyberion/${path.relative(pathResolver.rootDir(), REPORT_PATH)})`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildReport(current: CurrentIndexRecord[], legacy: LegacyRecord[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: Component Lifecycle Inventory');
  lines.push('category: Architecture');
  lines.push('tags: [architecture, actuators, cleanup, governance]');
  lines.push('importance: 8');
  lines.push('author: Ecosystem Architect');
  lines.push(`last_updated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('---');
  lines.push('');
  lines.push('# Component Lifecycle Inventory');
  lines.push('');
  lines.push('This inventory is generated from the filesystem. Manifest-backed actuators are treated as the current runtime surface. Directories without a manifest are treated as legacy-review components until they are either migrated or retired.');
  lines.push('');
  lines.push('## Current Runtime Surface');
  lines.push('');
  lines.push('- Source of truth: `libs/actuators/*/manifest.json`');
  lines.push(`- Count: ${current.length}`);
  lines.push('- Rule: If a component should be discoverable by the CLI or governance layer, it needs a `manifest.json`.');
  lines.push('');
  for (const actuator of current) {
    lines.push(`- \`${actuator.n}\`: ${actuator.d} (${actuator.capability_count} ops, v${actuator.version}${actuator.contract_schema ? `, schema ${actuator.contract_schema}` : ''})`);
  }
  lines.push('');
  lines.push('## Legacy Review Queue');
  lines.push('');
  lines.push(`- Source of truth: [legacy_component_index.json](/Users/famao/kyberion/${path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH)})`);
  lines.push(`- Count: ${legacy.length}`);
  lines.push('');
  for (const component of legacy) {
    lines.push(`- \`${component.name}\`: ${component.rationale}`);
  }
  lines.push('');
  lines.push('## Consolidation Recommendations');
  lines.push('');
  lines.push('- Retire `physical-bridge` by expressing its orchestration as ADF over `browser-actuator`, `system-actuator`, and `media-generation-actuator` instead of shelling back through `cli.js`.');
  lines.push('- Review `daemon-actuator` against `surface-runtime` and `process-actuator`; keep only one long-lived process lifecycle model.');
  lines.push('- Treat `vision-actuator` as compatibility-only and continue moving generation concerns into `media-generation-actuator` while keeping perception-oriented work elsewhere.');
  lines.push('- Keep `approval-actuator`, `code-actuator`, `network-actuator`, and `process-actuator` manifest-backed because governance or runtime layers still reference them directly.');
  lines.push('- Do not use `CAPABILITIES_GUIDE.md` as the source of truth for runtime discovery; it is broader and currently includes historical capability names that do not map 1:1 to actuator packages.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  return withExecutionContext('component_inventory_sync', () => {
    const knowledgeDir = path.dirname(REPORT_PATH);
    if (!safeExistsSync(knowledgeDir)) {
      safeMkdir(knowledgeDir, { recursive: true });
    }

    const { current, legacy } = collectComponentInventory();
    writeJsonArtifacts(current, legacy);
    safeWriteFile(REPORT_PATH, buildReport(current, legacy));
    safeWriteFile(CAPABILITIES_GUIDE_PATH, buildCapabilitiesGuide(current));
    console.log(JSON.stringify({
      status: 'ok',
      current_count: current.length,
      legacy_count: legacy.length,
      current_index_path: path.relative(pathResolver.rootDir(), CURRENT_INDEX_PATH),
      skill_index_path: path.relative(pathResolver.rootDir(), SKILL_INDEX_PATH),
      legacy_index_path: path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH),
      report_path: path.relative(pathResolver.rootDir(), REPORT_PATH),
      capabilities_guide_path: path.relative(pathResolver.rootDir(), CAPABILITIES_GUIDE_PATH),
    }, null, 2));
  }, 'ecosystem_architect');
}

main();
