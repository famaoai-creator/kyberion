import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import {} from '../libs/actuators/system-actuator/src/op-catalog.js';
import { readJsonFile } from './refactor/cli-input.js';

interface CapabilityManifest {
  actuator_id: string;
  version: string;
  description: string;
  contract_schema?: string;
  capabilities: Array<{
    op: string;
    platforms: string[];
    requirements?: { bin?: string[]; env?: string[]; lib?: string[] };
    prerequisites?: {
      binaries?: string[];
      platforms?: string[];
      env?: string[];
      services?: string[];
      install?: string[] | Record<string, string>;
    };
  }>;
}

interface CurrentIndexRecord {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
  ops: string[];
  contract_schema?: string;
  prerequisites_summary: string;
}

interface LegacyRecord {
  name: string;
  path: string;
  status: 'legacy-review';
  package_based: boolean;
  rationale: string;
}

const ACTUATORS_DIR = pathResolver.rootResolve('libs/actuators');
const CURRENT_INDEX_PATH = pathResolver.knowledge(
  'product/orchestration/global_actuator_index.json'
);
const SKILL_INDEX_PATH = pathResolver.knowledge('product/orchestration/global_skill_index.json');
const LEGACY_INDEX_PATH = pathResolver.knowledge(
  'product/orchestration/legacy_component_index.json'
);
const REPORT_PATH = pathResolver.knowledge('product/architecture/component-lifecycle-inventory.md');
const CAPABILITIES_GUIDE_PATH = pathResolver.rootResolve('CAPABILITIES_GUIDE.md');

const LEGACY_RATIONALES: Record<string, string> = {
  'daemon-actuator':
    'Launchd-era runtime management overlaps with surface-runtime and managed process supervision.',
  'physical-bridge':
    'Retired 2026-05-28 → retired/actuators/physical-bridge/. Was a thin wrapper that shelled into browser/system actuators via temp files. Replaced by direct ADF orchestration.',
};

function summarizePrerequisites(manifest: CapabilityManifest): string {
  const parts = new Set<string>();
  for (const capability of manifest.capabilities || []) {
    for (const binary of capability.prerequisites?.binaries || capability.requirements?.bin || []) {
      parts.add(`bin:${binary}`);
    }
    for (const envName of capability.prerequisites?.env || capability.requirements?.env || []) {
      parts.add(`env:${envName}`);
    }
    for (const service of capability.prerequisites?.services || []) {
      parts.add(`svc:${service}`);
    }
    for (const platformName of capability.prerequisites?.platforms || []) {
      parts.add(`os:${platformName}`);
    }
  }
  return parts.size > 0 ? Array.from(parts).sort().join(', ') : '-';
}

function listOps(manifest: CapabilityManifest): string[] {
  return Array.from(
    new Set(
      (manifest.capabilities || []).map((capability) => String(capability.op || '')).filter(Boolean)
    )
  ).sort();
}

function loadManifest(manifestPath: string): CapabilityManifest {
  return JSON.parse(
    safeReadFile(manifestPath, { encoding: 'utf8' }) as string
  ) as CapabilityManifest;
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
        ops: listOps(manifest),
        contract_schema: manifest.contract_schema,
        prerequisites_summary: summarizePrerequisites(manifest),
      });
      continue;
    }

    legacy.push({
      name: entry,
      path: path.posix.join('libs/actuators', entry),
      status: 'legacy-review',
      package_based: safeExistsSync(packagePath),
      rationale:
        LEGACY_RATIONALES[entry] ||
        'Not manifest-backed, so it is invisible to runtime discovery and needs explicit retirement or migration review.',
    });
  }

  return { current, legacy };
}

function writeJsonArtifacts(current: CurrentIndexRecord[], legacy: LegacyRecord[]) {
  safeWriteFile(
    CURRENT_INDEX_PATH,
    JSON.stringify(
      {
        v: '2.0.0',
        t: current.length,
        actuators: current,
      },
      null,
      2
    ) + '\n'
  );

  safeWriteFile(
    LEGACY_INDEX_PATH,
    JSON.stringify(
      {
        v: '1.0.0',
        t: legacy.length,
        components: legacy,
      },
      null,
      2
    ) + '\n'
  );

  safeWriteFile(
    SKILL_INDEX_PATH,
    JSON.stringify(
      {
        v: '3.0.0',
        t: current.length,
        s: current.map((entry) => ({
          n: entry.n,
          path: entry.path,
          d: entry.d,
          s: entry.s,
          version: entry.version,
          capability_count: entry.capability_count,
        })),
      },
      null,
      2
    ) + '\n'
  );
}

interface DiscoveryOpsRecord {
  n: string;
  ops: Array<{ op: string; kind: 'capture' | 'transform' | 'apply' | 'control' }>;
}

// AR-02: the op tables are generated from the self-described discovery index
// (all actuators), not just the system actuator's exported constants.
function loadDiscoveryOps(): DiscoveryOpsRecord[] {
  const discoveryPath = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');
  try {
    const parsed = JSON.parse(safeReadFile(discoveryPath, { encoding: 'utf8' }) as string) as {
      actuators?: DiscoveryOpsRecord[];
    };
    return parsed.actuators ?? [];
  } catch {
    return [];
  }
}

function buildOpKindTable(kind: 'capture' | 'transform' | 'apply' | 'control'): string[] {
  const rows = new Map<string, string[]>();
  for (const record of loadDiscoveryOps()) {
    for (const item of record.ops) {
      if (item.kind !== kind) continue;
      const owners = rows.get(item.op) ?? [];
      owners.push(record.n.replace(/-actuator$/, ''));
      rows.set(item.op, owners);
    }
  }
  const lines: string[] = ['| Op | Actuators |', '| :--- | :--- |'];
  for (const [op, owners] of [...rows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| \`${op}\` | ${[...new Set(owners)].sort().join(', ')} |`);
  }
  return lines;
}

function buildCapabilitiesGuide(current: CurrentIndexRecord[]): string {
  const lines: string[] = [];
  lines.push('# Kyberion Capabilities Guide');
  lines.push('');
  lines.push(`Total Actuators: ${current.length}`);
  lines.push(`Last updated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(
    'This guide is generated from `libs/actuators/*/manifest.json` (actuator table) and `knowledge/product/orchestration/actuator-op-discovery.json` (op tables, sourced from each actuator describeOps). Human-readable counterpart to `global_actuator_index.json`.'
  );
  lines.push('');
  lines.push(
    'Legacy or conceptual capability names are intentionally excluded here. If a component is not manifest-backed, it is not part of the current runtime catalog.'
  );
  lines.push('');
  lines.push(
    '| Actuator | Description | Version | Ops Count | Ops | Prerequisites | Contract Schema | Path |'
  );
  lines.push('| :--- | :--- | :--- | :---: | :--- | :--- | :--- | :--- |');
  for (const actuator of current) {
    lines.push(
      `| \`${actuator.n}\` | ${actuator.d} | ${actuator.version} | ${actuator.capability_count} | \`${actuator.ops.join(', ') || '-'}\` | \`${actuator.prerequisites_summary}\` | \`${actuator.contract_schema || '-'}\` | \`${actuator.path}\` |`
    );
  }
  lines.push('');
  lines.push('### Capture ops (type: capture)');
  lines.push('');
  lines.push(...buildOpKindTable('capture'));
  lines.push('');
  lines.push('### Transform ops (type: transform)');
  lines.push('');
  lines.push(...buildOpKindTable('transform'));
  lines.push('');
  lines.push('### Apply ops (type: apply)');
  lines.push('');
  lines.push(...buildOpKindTable('apply'));
  lines.push('');
  lines.push('### Control ops (type: control)');
  lines.push('');
  lines.push(...buildOpKindTable('control'));
  lines.push('');
  lines.push('## Capability Boundaries');
  lines.push('');
  lines.push(
    'Several use cases map to more than one actuator by name alone. This table is the tie-breaker (AC-06).'
  );
  lines.push('');
  lines.push('| Use case | Use this | Avoid / why |');
  lines.push('| :--- | :--- | :--- |');
  lines.push(
    "| Screen capture and recording (general purpose) | `system-actuator` (`screenshot`, `record_screen`, `test_screen_stream`, `test_screen_mp4_roundtrip`) | `media-generation-actuator`'s capture names are compatibility forwarders for generation workflows. |"
  );
  lines.push(
    '| Document rendering from a template (pptx/docx/pdf, partial updates) | `media-actuator` | Deterministic rendering, not generative — use `media-generation-actuator` for content that has to be authored/synthesized. |'
  );
  lines.push(
    '| Generative image, video, or music | `media-generation-actuator` | `media-actuator` only renders from existing templates/content; it does not generate. |'
  );
  lines.push(
    "| Assembling a narrated video from scenes/briefs | `video-composition-actuator` | Distinct from `media-generation-actuator`'s `generate_video`, which produces a single generative video clip rather than composing a narrated sequence. |"
  );
  lines.push(
    '| Image perception (OCR, layout/content inspection) | `vision-actuator` (`inspect_image`, `ocr_image`) | `vision-actuator` is perception-only; its generation-shaped ops are compatibility facades that forward to `media-generation-actuator`. |'
  );
  lines.push(
    '| One-shot OS command / shell | `system-actuator` (`pipeline` → `system:exec`, `system:shell`) | Use `process-actuator` instead if the command must be supervised or outlive the calling step. |'
  );
  lines.push(
    '| Supervised, long-lived process (start/stop/status) | `process-actuator` | `system-actuator` and `terminal-actuator` do not track process lifecycle across steps. |'
  );
  lines.push(
    "| Interactive terminal session (PTY, read/write a running shell) | `terminal-actuator` | `system-actuator`'s `pipeline` ops run a command to completion; they do not expose an interactive PTY. |"
  );
  lines.push('');
  lines.push('## Governed Core Workloads');
  lines.push('');
  lines.push(
    '`@agent/core` also exposes the additive marketing workload contract for G0 intake, G1 data classification, G2 claims, G3 video/text/image validation, G4 independent review, G5 shared human approval binding, G6 publication verification, risk-policy resolution, and evidence-aware Mission completion.'
  );
  lines.push('');
  lines.push(
    'The workload composes the existing approval, artifact, media generation, video composition, browser, customer overlay, and Mission evidence capabilities. It does not register a marketing-specific Actuator or grant Strategy, Creative, or Review roles external publication authority.'
  );
  lines.push('');
  lines.push(
    'Canonical templates: `knowledge/product/pipeline-templates/video-production.json`, `publication-review.json`, and `publish-youtube-dry-run.json`.'
  );
  lines.push('');
  lines.push('See also:');
  lines.push('');
  lines.push('- Source manifests: `libs/actuators/*/manifest.json`');
  lines.push(
    `- Compatibility snapshot: [global_actuator_index.json](${path.relative(pathResolver.rootDir(), CURRENT_INDEX_PATH)})`
  );
  lines.push(
    `- [legacy_component_index.json](${path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH)})`
  );
  lines.push(
    `- [component-lifecycle-inventory.md](${path.relative(pathResolver.rootDir(), REPORT_PATH)})`
  );
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
  lines.push('---');
  lines.push('');
  lines.push('# Component Lifecycle Inventory');
  lines.push('');
  lines.push(
    'This inventory is generated from the filesystem. Manifest-backed actuators are treated as the current runtime surface. Directories without a manifest are treated as legacy-review components until they are either migrated or retired.'
  );
  lines.push('');
  lines.push('## Current Runtime Surface');
  lines.push('');
  lines.push('- Source of truth: `libs/actuators/*/manifest.json`');
  lines.push(`- Count: ${current.length}`);
  lines.push(
    '- Rule: If a component should be discoverable by the CLI or governance layer, it needs a `manifest.json`.'
  );
  lines.push('');
  for (const actuator of current) {
    lines.push(
      `- \`${actuator.n}\`: ${actuator.d} (${actuator.capability_count} ops, v${actuator.version}${actuator.contract_schema ? `, schema ${actuator.contract_schema}` : ''})`
    );
  }
  lines.push('');
  lines.push('## Legacy Review Queue');
  lines.push('');
  lines.push(
    `- Source of truth: [legacy_component_index.json](${path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH)})`
  );
  lines.push(`- Count: ${legacy.length}`);
  lines.push('');
  for (const component of legacy) {
    lines.push(`- \`${component.name}\`: ${component.rationale}`);
  }
  lines.push('');
  lines.push('## Consolidation Recommendations');
  lines.push('');
  lines.push(
    '- `physical-bridge` has been retired to `retired/actuators/physical-bridge/` (2026-05-28). No action required.'
  );
  lines.push(
    '- Review `daemon-actuator` against `surface-runtime` and `process-actuator`; keep only one long-lived process lifecycle model.'
  );
  lines.push(
    '- Treat `vision-actuator` as compatibility-only and continue moving generation concerns into `media-generation-actuator` while keeping perception-oriented work elsewhere.'
  );
  lines.push(
    '- Keep `approval-actuator`, `code-actuator`, `network-actuator`, and `process-actuator` manifest-backed because governance or runtime layers still reference them directly.'
  );
  lines.push(
    '- Do not use `CAPABILITIES_GUIDE.md` as the source of truth for runtime discovery; it is broader and currently includes historical capability names that do not map 1:1 to actuator packages.'
  );
  return `${lines.join('\n')}\n`;
}

function main() {
  return withExecutionContext(
    'component_inventory_sync',
    () => {
      const knowledgeDir = path.dirname(REPORT_PATH);
      if (!safeExistsSync(knowledgeDir)) {
        safeMkdir(knowledgeDir);
      }

      const { current, legacy } = collectComponentInventory();
      writeJsonArtifacts(current, legacy);
      safeWriteFile(REPORT_PATH, buildReport(current, legacy));
      safeWriteFile(CAPABILITIES_GUIDE_PATH, buildCapabilitiesGuide(current));
      console.log(
        JSON.stringify(
          {
            status: 'ok',
            current_count: current.length,
            legacy_count: legacy.length,
            current_index_path: path.relative(pathResolver.rootDir(), CURRENT_INDEX_PATH),
            skill_index_path: path.relative(pathResolver.rootDir(), SKILL_INDEX_PATH),
            legacy_index_path: path.relative(pathResolver.rootDir(), LEGACY_INDEX_PATH),
            report_path: path.relative(pathResolver.rootDir(), REPORT_PATH),
            capabilities_guide_path: path.relative(pathResolver.rootDir(), CAPABILITIES_GUIDE_PATH),
          },
          null,
          2
        )
      );
    },
    'ecosystem_architect'
  );
}

main();
