/**
 * Validation Bundle Exporter (IP-13)
 *
 * Assembles the SR-11-7-class evidence bundle described in
 * `knowledge/public/governance/independent-validation-evidence-package.md`.
 *
 * Usage:
 *   node dist/scripts/export_validation_bundle.js <MISSION_ID> [--output <dir>]
 *
 * The bundle is a directory tree (not yet a tar.gz — that is a packaging
 * concern best handled by the deploying organization). Layout:
 *
 *   <output>/<MISSION_ID>-validation-bundle/
 *     manifest.json                 — what is in the bundle, with checksums
 *     output/                       — §2.1 the output under review
 *       simulation-summary.json
 *       simulation-quality.json
 *       simulation-ensemble.json    (if present)
 *       hypothesis-tree.json
 *       dissent-log.json
 *       (any *.md report)
 *     reasoning-context/            — §2.2
 *       mission-state.json
 *       mission-state-history.jsonl (one line per checkpoint, from Git)
 *     reasoning-environment/        — §2.3
 *       package.json
 *       pnpm-lock.yaml
 *     audit-story/                  — §2.4
 *       audit-chain-mission.jsonl   (events filtered by mission_id)
 *       audit-chain-overrides.jsonl (rubric.override_accepted events only)
 *     governance/                   — §2.5
 *       counterfactual-degradation-policy.json
 *       mission-classification-policy.json
 *       tier-hygiene-policy.json
 *       (rubric-disclosure-template.md)
 *     attestations/
 *       README.md                   — what to sign before delivery
 *
 * The exporter never mutates anything outside <output>. Operator
 * attestations are an explicit manual step (see attestations/README.md).
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  logger,
  pathResolver,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  safeLstat,
  findMissionPath,
  missionEvidenceDir,
} from '@agent/core';

interface BundleManifest {
  mission_id: string;
  generated_at: string;
  bundle_layout_version: '1.0.0';
  files: Array<{
    relative_path: string;
    bytes: number;
    sha256: string;
    source: string;
  }>;
  notes: string[];
}

function sha256OfFile(absPath: string): { bytes: number; sha256: string } {
  const buf = safeReadFile(absPath) as Buffer;
  const sha = createHash('sha256').update(buf).digest('hex');
  return { bytes: buf.length, sha256: sha };
}

function copyIntoBundle(srcAbs: string, bundleRoot: string, relIntoBundle: string): {
  rel: string;
  bytes: number;
  sha256: string;
} | null {
  if (!safeExistsSync(srcAbs)) return null;
  const destAbs = path.join(bundleRoot, relIntoBundle);
  safeMkdir(path.dirname(destAbs), { recursive: true });
  const buf = safeReadFile(srcAbs) as Buffer;
  safeWriteFile(destAbs, buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  return { rel: relIntoBundle, bytes: buf.length, sha256: sha };
}

function copyDirIntoBundle(
  srcDirAbs: string,
  bundleRoot: string,
  relIntoBundleDir: string,
): Array<{ rel: string; bytes: number; sha256: string }> {
  if (!safeExistsSync(srcDirAbs)) return [];
  const out: Array<{ rel: string; bytes: number; sha256: string }> = [];
  for (const entry of safeReaddir(srcDirAbs)) {
    const srcAbs = path.join(srcDirAbs, entry);
    let stat;
    try {
      stat = safeLstat(srcAbs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = copyDirIntoBundle(srcAbs, bundleRoot, `${relIntoBundleDir}/${entry}`);
      out.push(...nested);
      continue;
    }
    if (!stat.isFile()) continue;
    const result = copyIntoBundle(srcAbs, bundleRoot, `${relIntoBundleDir}/${entry}`);
    if (result) out.push(result);
  }
  return out;
}

function filterAuditChainByMission(
  auditDir: string,
  missionId: string,
): { allEvents: any[]; overrideEvents: any[] } {
  const allEvents: any[] = [];
  const overrideEvents: any[] = [];
  if (!safeExistsSync(auditDir)) return { allEvents, overrideEvents };
  for (const entry of safeReaddir(auditDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const abs = path.join(auditDir, entry);
    const txt = safeReadFile(abs, { encoding: 'utf8' }) as string;
    for (const line of txt.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const matches =
        (event.metadata && event.metadata.mission_id === missionId) ||
        (typeof event.operation === 'string' && event.operation.includes(missionId)) ||
        event.mission_id === missionId;
      if (!matches) continue;
      allEvents.push(event);
      if (event.action === 'rubric.override_accepted' || event.type === 'rubric.override_accepted') {
        overrideEvents.push(event);
      }
    }
  }
  return { allEvents, overrideEvents };
}

function writeJsonl(absPath: string, lines: any[]): { bytes: number; sha256: string } {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  safeMkdir(path.dirname(absPath), { recursive: true });
  safeWriteFile(absPath, text);
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function exportBundle(missionId: string, outputBaseDir: string): string {
  const upperId = missionId.toUpperCase();
  const missionPath = findMissionPath(upperId);
  if (!missionPath) {
    throw new Error(`Mission not found: ${upperId}`);
  }
  const evidenceDir = missionEvidenceDir(upperId);
  if (!evidenceDir) {
    throw new Error(`Mission evidence dir not found: ${upperId}`);
  }

  const bundleRoot = path.join(outputBaseDir, `${upperId}-validation-bundle`);
  if (safeExistsSync(bundleRoot)) {
    throw new Error(
      `Bundle already exists at ${bundleRoot}; refusing to overwrite. Move or delete the existing one first.`,
    );
  }
  safeMkdir(bundleRoot, { recursive: true });

  const manifest: BundleManifest = {
    mission_id: upperId,
    generated_at: new Date().toISOString(),
    bundle_layout_version: '1.0.0',
    files: [],
    notes: [],
  };

  // §2.1 output under review — copy the whole evidence directory under output/
  for (const entry of safeReaddir(evidenceDir)) {
    if (entry === '.gitkeep') continue;
    const srcAbs = path.join(evidenceDir, entry);
    let stat;
    try {
      stat = safeLstat(srcAbs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = copyDirIntoBundle(srcAbs, bundleRoot, `output/${entry}`);
      for (const n of nested) {
        manifest.files.push({
          relative_path: n.rel,
          bytes: n.bytes,
          sha256: n.sha256,
          source: `mission/evidence/${entry}/`,
        });
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const r = copyIntoBundle(srcAbs, bundleRoot, `output/${entry}`);
    if (r) {
      manifest.files.push({
        relative_path: r.rel,
        bytes: r.bytes,
        sha256: r.sha256,
        source: 'mission/evidence/',
      });
    }
  }

  // §2.2 reasoning context — mission state + Git checkpoint history
  const stateAbs = path.join(missionPath, 'mission-state.json');
  const stateCopy = copyIntoBundle(stateAbs, bundleRoot, 'reasoning-context/mission-state.json');
  if (stateCopy) {
    manifest.files.push({
      relative_path: stateCopy.rel,
      bytes: stateCopy.bytes,
      sha256: stateCopy.sha256,
      source: 'mission-state.json',
    });
  }
  const teamAbs = path.join(missionPath, 'team-composition.json');
  const teamCopy = copyIntoBundle(teamAbs, bundleRoot, 'reasoning-context/team-composition.json');
  if (teamCopy) {
    manifest.files.push({
      relative_path: teamCopy.rel,
      bytes: teamCopy.bytes,
      sha256: teamCopy.sha256,
      source: 'team-composition.json',
    });
  }

  // §2.3 reasoning environment — package + lockfile snapshot
  for (const f of ['package.json', 'pnpm-lock.yaml']) {
    const abs = pathResolver.rootResolve(f);
    const r = copyIntoBundle(abs, bundleRoot, `reasoning-environment/${f}`);
    if (r) {
      manifest.files.push({
        relative_path: r.rel,
        bytes: r.bytes,
        sha256: r.sha256,
        source: f,
      });
    }
  }

  // §2.4 audit story — filter audit ledger by mission id
  const auditDir = pathResolver.rootResolve('active/audit');
  const { allEvents, overrideEvents } = filterAuditChainByMission(auditDir, upperId);
  const allOut = path.join(bundleRoot, 'audit-story/audit-chain-mission.jsonl');
  const allMeta = writeJsonl(allOut, allEvents);
  manifest.files.push({
    relative_path: 'audit-story/audit-chain-mission.jsonl',
    bytes: allMeta.bytes,
    sha256: allMeta.sha256,
    source: 'audit-chain (filtered)',
  });
  const overrideOut = path.join(bundleRoot, 'audit-story/audit-chain-overrides.jsonl');
  const overrideMeta = writeJsonl(overrideOut, overrideEvents);
  manifest.files.push({
    relative_path: 'audit-story/audit-chain-overrides.jsonl',
    bytes: overrideMeta.bytes,
    sha256: overrideMeta.sha256,
    source: 'audit-chain (overrides only)',
  });

  // §2.5 governance — copy current versions
  const govFiles = [
    'knowledge/public/governance/counterfactual-degradation-policy.json',
    'knowledge/public/governance/mission-classification-policy.json',
    'knowledge/public/governance/tier-hygiene-policy.json',
    'knowledge/public/governance/path-scope-policy.json',
    'knowledge/public/procedures/system/rubric-disclosure-template.md',
  ];
  for (const g of govFiles) {
    const abs = pathResolver.rootResolve(g);
    const filename = path.basename(g);
    const r = copyIntoBundle(abs, bundleRoot, `governance/${filename}`);
    if (r) {
      manifest.files.push({
        relative_path: r.rel,
        bytes: r.bytes,
        sha256: r.sha256,
        source: g,
      });
    } else {
      manifest.notes.push(`governance file missing at export time: ${g}`);
    }
  }

  // §2.6 attestations — operator-action README
  const attestReadme = `# Attestations

Per \`independent-validation-evidence-package.md\` §2.6, this bundle is
incomplete until the following attestations are signed by the named role.

Place each signed attestation as a JSON file in this directory:

  - mission-owner.signed.json
  - knowledge-steward.signed.json
  - tenant-risk-officer.signed.json
  - ecosystem-architect.signed.json

Suggested JSON shape:

\`\`\`json
{
  "attestation": "All artefacts in §2.1–§2.5 are unmodified copies of the production run.",
  "mission_id": "${upperId}",
  "signed_by": {
    "role": "mission_owner",
    "name": "<full name>",
    "email": "<email>"
  },
  "signed_at": "2026-XX-XXTXX:XX:XXZ",
  "manifest_sha256": "<sha256 of ../manifest.json>",
  "signature": "<detached signature bytes if applicable>"
}
\`\`\`

Until all four signed.json files are present, the bundle is *draft* and
must not be handed to an external validator.
`;
  const attestPath = path.join(bundleRoot, 'attestations/README.md');
  safeMkdir(path.dirname(attestPath), { recursive: true });
  safeWriteFile(attestPath, attestReadme);
  const attestMeta = sha256OfFile(attestPath);
  manifest.files.push({
    relative_path: 'attestations/README.md',
    bytes: attestMeta.bytes,
    sha256: attestMeta.sha256,
    source: 'generated',
  });

  // Write manifest last
  manifest.files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const manifestPath = path.join(bundleRoot, 'manifest.json');
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return bundleRoot;
}

function main(): number {
  const args = process.argv.slice(2);
  const missionId = args.find((a) => !a.startsWith('--'));
  if (!missionId) {
    logger.error('Usage: node dist/scripts/export_validation_bundle.js <MISSION_ID> [--output <dir>]');
    return 1;
  }
  const outputIdx = args.indexOf('--output');
  const outputBase = outputIdx >= 0 && args[outputIdx + 1]
    ? path.resolve(args[outputIdx + 1])
    : pathResolver.rootResolve('active/shared/exports/validation-bundles');
  safeMkdir(outputBase, { recursive: true });
  try {
    const bundlePath = exportBundle(missionId, outputBase);
    logger.success(`✅ Validation bundle exported to: ${bundlePath}`);
    logger.info('Next steps: gather attestations per attestations/README.md before delivery.');
    return 0;
  } catch (err: any) {
    logger.error(`[export-validation-bundle] failed: ${err?.message ?? err}`);
    return 1;
  }
}

const isDirect = process.argv[1] && /export_validation_bundle\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  process.exit(main());
}

export { exportBundle };
