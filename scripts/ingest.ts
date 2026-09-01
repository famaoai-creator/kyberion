#!/usr/bin/env node
/**
 * scripts/ingest.ts — DA-05 explicit ingest ceremony CLI (案7 Hybrid
 * Sovereign Ledger). Drives the ingest-actuator handlers in-process:
 *
 *   parse_document → dedup → normalize_card → ingest:commit
 *
 * There is deliberately no auto-ingest / watch mode — an operator (or a
 * mission task) invokes this once per document, and the who/when/why is
 * recorded in the tenant's information-asset ledger
 * (knowledge/confidential/{tenant}/_ledger/assets.jsonl).
 *
 * Usage:
 *   pnpm ingest --tenant <slug> --file <path> [--format docx|pdf|xlsx|html|slack_thread|markdown|text]
 *               [--source-system <sys>] [--source-id <id>] [--target <relative_path>]
 *               [--kind <card kind>] [--approval-id <id>] [--ingested-by <who>]
 *               [--dry-run] [--root-dir <fixture root>]
 *
 * --dry-run stops before commit and prints what would happen (dedup check
 * runs in check-only mode — nothing is registered or written).
 * --root-dir is a test seam: tenant registry, ledger, landing root and dedup
 * registry all resolve under the given fixture root instead of the repo.
 *
 * Identity is explicit over implicit: without --ingested-by or an active
 * KYBERION_PERSONA / MISSION_ROLE, the ceremony refuses to run.
 */

import * as path from 'node:path';
import { deriveAssetId, findAssetBySource } from '@agent/core/ingest-asset-ledger';
import { proposeTierPlacement } from '@agent/core/ingest-tier-gate';
import { scanContent } from '@agent/core/pii-scrubber';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  commitIngest,
  dedupContent,
  normalizeCard,
  parseDocument,
  type IngestFormat,
} from '../libs/actuators/ingest-actuator/src/index.js';

const FORMATS: IngestFormat[] = ['docx', 'pdf', 'xlsx', 'html', 'slack_thread', 'markdown', 'text'];

const EXTENSION_FORMATS: Record<string, IngestFormat> = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.xlsx': 'xlsx',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
};

const USAGE = `DA-05 explicit ingest ceremony — land one document as a governed knowledge card.

Usage:
  pnpm ingest --tenant <slug> --file <path> [options]

Required:
  --tenant <slug>          Registered tenant slug (or 'common' for the shared namespace)
  --file <path>            Document to ingest (repo-relative or absolute)

Options:
  --format <fmt>           One of: ${FORMATS.join(', ')} (default: inferred from extension)
  --source-system <sys>    Source system recorded in the ledger (default: file)
  --source-id <id>         Stable source id (default: the --file path) — re-ingests of the
                           same source become supersede versions, so keep it stable
  --target <relative>      Landing path relative to the tenant knowledge root
                           (default: ingest/<file-stem>.md)
  --kind <kind>            knowledge-card kind for taxonomy defaults (default: reference)
  --approval-id <id>       Approval reference recorded in the ledger
  --ingested-by <who>      Ceremony identity (default: KYBERION_PERSONA, then MISSION_ROLE;
                           refused when none is resolvable)
  --propose-tier           Print the DA-06 tier-placement proposal (advisory only)
  --source-public          Assert the source is already public (tier proposal input only)
  --steward-approval-id <id>
                           KM-03 steward approval — required for common/public landings
  --override-rules <a,b>   DA-06 false-positive override: block rules downgraded to mask
  --override-reason <why>  Required with --override-rules (audited)
  --override-approved-by <who>
                           Required with --override-rules (audited)
  --dry-run                Print what would happen and stop before any write
  --root-dir <path>        Test seam: fixture root for tenant registry / ledger / landing
  --help                   Show this help
`;

interface CliArgs {
  tenant?: string;
  file?: string;
  format?: string;
  sourceSystem?: string;
  sourceId?: string;
  target?: string;
  kind?: string;
  approvalId?: string;
  ingestedBy?: string;
  proposeTier: boolean;
  sourcePublic: boolean;
  stewardApprovalId?: string;
  overrideRules?: string;
  overrideReason?: string;
  overrideApprovedBy?: string;
  dryRun: boolean;
  rootDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, help: false, proposeTier: false, sourcePublic: false };
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--tenant':
        args.tenant = takeValue('--tenant', i);
        i += 1;
        break;
      case '--file':
        args.file = takeValue('--file', i);
        i += 1;
        break;
      case '--format':
        args.format = takeValue('--format', i);
        i += 1;
        break;
      case '--source-system':
        args.sourceSystem = takeValue('--source-system', i);
        i += 1;
        break;
      case '--source-id':
        args.sourceId = takeValue('--source-id', i);
        i += 1;
        break;
      case '--target':
        args.target = takeValue('--target', i);
        i += 1;
        break;
      case '--kind':
        args.kind = takeValue('--kind', i);
        i += 1;
        break;
      case '--approval-id':
        args.approvalId = takeValue('--approval-id', i);
        i += 1;
        break;
      case '--ingested-by':
        args.ingestedBy = takeValue('--ingested-by', i);
        i += 1;
        break;
      case '--propose-tier':
        args.proposeTier = true;
        break;
      case '--source-public':
        args.sourcePublic = true;
        break;
      case '--steward-approval-id':
        args.stewardApprovalId = takeValue('--steward-approval-id', i);
        i += 1;
        break;
      case '--override-rules':
        args.overrideRules = takeValue('--override-rules', i);
        i += 1;
        break;
      case '--override-reason':
        args.overrideReason = takeValue('--override-reason', i);
        i += 1;
        break;
      case '--override-approved-by':
        args.overrideApprovedBy = takeValue('--override-approved-by', i);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--root-dir':
        args.rootDir = takeValue('--root-dir', i);
        i += 1;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument '${argv[i]}' (see --help)`);
    }
  }
  return args;
}

function resolveFormat(args: CliArgs, filePath: string): IngestFormat {
  if (args.format) {
    if (!FORMATS.includes(args.format as IngestFormat)) {
      throw new Error(`--format must be one of: ${FORMATS.join(', ')} (got '${args.format}')`);
    }
    return args.format as IngestFormat;
  }
  const inferred = EXTENSION_FORMATS[path.extname(filePath).toLowerCase()];
  if (!inferred) {
    throw new Error(
      `cannot infer format from '${path.extname(filePath) || '(no extension)'}' — ` +
        `pass --format (one of: ${FORMATS.join(', ')})`
    );
  }
  return inferred;
}

function resolveIdentity(args: CliArgs): string {
  const explicit = String(args.ingestedBy || '').trim();
  if (explicit) return explicit;
  const persona = String(getRegisteredEnvText('KYBERION_PERSONA') || '').trim();
  if (persona) return persona;
  const role = String(process.env.MISSION_ROLE || '').trim();
  if (role) return role;
  throw new Error(
    'no ingest identity — pass --ingested-by <who> or run with KYBERION_PERSONA / MISSION_ROLE set. ' +
      'The ledger records WHO performed every ingest; anonymous ingests are refused.'
  );
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    console.log(USAGE);
    return;
  }
  if (!args.tenant) throw new Error('--tenant is required (see --help)');
  if (!args.file) throw new Error('--file is required (see --help)');

  const rootDir = args.rootDir ? path.resolve(args.rootDir) : pathResolver.rootDir();
  const pathOptions = args.rootDir ? { rootDir, env: {} as NodeJS.ProcessEnv } : {};
  const absFile = path.isAbsolute(args.file) ? args.file : path.resolve(rootDir, args.file);
  if (!safeExistsSync(absFile)) throw new Error(`--file not found: ${absFile}`);

  const format = resolveFormat(args, absFile);
  const ingestedBy = resolveIdentity(args);
  const sourceSystem = String(args.sourceSystem || 'file').trim();
  const sourceId = String(args.sourceId || args.file).trim();
  const fileStem = path.basename(absFile, path.extname(absFile));
  const relativeTarget = args.target || `ingest/${fileStem}.md`;
  // In fixture mode the dedup registry moves under the fixture root too, so
  // a --root-dir run never pollutes the real shared registry.
  const registryPath = args.rootDir
    ? path.join(rootDir, 'active/shared/runtime/ingest/content-hash-registry.jsonl')
    : undefined;

  console.log(`[ingest] tenant=${args.tenant} file=${absFile} format=${format}`);
  console.log(`[ingest] source=${sourceSystem}::${sourceId} ingested_by=${ingestedBy}`);

  // 1. parse_document — raw bytes → unified IR (content_sha256 over raw bytes).
  const ir = await parseDocument({
    source_path: absFile,
    format,
    source_meta: {
      source_system: sourceSystem,
      source_id: sourceId,
      retrieved_at: new Date().toISOString(),
    },
  });

  // 2. normalize_card — IR → schema-validated card (fail-closed).
  const normalized = normalizeCard({
    ir,
    target: { tenant_slug: args.tenant, relative_path: relativeTarget },
    card: { kind: args.kind || 'reference' },
    path_options: pathOptions,
  });

  // 2.5 DA-06 PII gate (pre-check) + advisory tier proposal. The
  // authoritative gate lives inside ingest:commit; this early check keeps a
  // blocked document from being registered in the dedup content-hash
  // registry (which would mark the fixed re-ingest a duplicate).
  const scan = scanContent(normalized.card_markdown);
  const overrideRuleIds = String(args.overrideRules || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const override =
    overrideRuleIds.length > 0
      ? {
          rule_ids: overrideRuleIds,
          reason: String(args.overrideReason || '').trim(),
          approved_by: String(args.overrideApprovedBy || '').trim(),
        }
      : undefined;
  if (args.proposeTier) {
    const proposal = proposeTierPlacement({
      source_meta: {
        source_system: sourceSystem,
        source_id: sourceId,
        explicitly_public: args.sourcePublic,
      },
      ...(args.tenant !== 'common' ? { tenant_slug: args.tenant } : {}),
      findings: scan.findings,
    });
    console.log('[ingest] tier placement proposal (advisory — steward approval decides):');
    console.log(JSON.stringify(proposal, null, 2));
  }
  const blockedRuleIds = scan.findings
    .filter((finding) => finding.action === 'block' && !overrideRuleIds.includes(finding.rule_id))
    .map((finding) => finding.rule_id);
  if (blockedRuleIds.length > 0) {
    throw new Error(
      `blocked by the PII/secret gate: [${blockedRuleIds.join(', ')}] — nothing was written or registered. ` +
        'If these are false positives, re-run with --override-rules/--override-reason/--override-approved-by (audited).'
    );
  }

  // 3. dedup — check-only for dry runs; registration happens on real runs.
  const dedup = dedupContent({
    content_sha256: ir.meta.content_sha256,
    source_system: sourceSystem,
    source_id: sourceId,
    target_path: normalized.target_path,
    register: !args.dryRun,
    ...(registryPath ? { registry_path: registryPath } : {}),
  });

  const assetId = deriveAssetId(sourceSystem, sourceId);
  const prior = findAssetBySource(args.tenant, sourceSystem, sourceId, pathOptions);

  if (args.dryRun) {
    const plan = {
      dry_run: true,
      tenant_slug: args.tenant,
      asset_id: assetId,
      target_path: prior?.target_path ?? normalized.target_path,
      content_sha256: ir.meta.content_sha256,
      would_commit: !dedup.duplicate,
      outcome: dedup.duplicate
        ? 'duplicate — nothing would be written'
        : prior
          ? `supersede — version ${prior.version + 1}, supersedes ${prior.asset_id}@v${prior.version}`
          : 'fresh — version 1',
      ingested_by: ingestedBy,
      transform_chain: [`parse_document:${format}`, 'normalize_card'],
      pii_findings: scan.findings,
      frontmatter: normalized.frontmatter,
    };
    console.log('[ingest] DRY RUN — no card written, no ledger record appended');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // 4. ingest:commit — the ceremony: card landing + ledger record + audit.
  const result = commitIngest({
    tenant_slug: args.tenant,
    normalized,
    dedup_result: dedup,
    source_meta: { ...ir.meta },
    ...(args.approvalId ? { approval_id: args.approvalId } : {}),
    ...(args.stewardApprovalId ? { steward_approval_id: args.stewardApprovalId } : {}),
    ...(override ? { override } : {}),
    ingested_by: ingestedBy,
    transform_chain: [`parse_document:${format}`, 'normalize_card'],
    path_options: pathOptions,
  });

  if (!result.committed) {
    console.log(`[ingest] NOT committed (${result.reason}) — the ledger is unchanged`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[ingest] committed ${result.provenance_ref} → ${result.target_path}`);
  console.log(JSON.stringify(result.asset, null, 2));
}

const script = defineScript({
  name: 'ingest',
  flags: [],
  run: ({ argv }) => main(argv),
});
if (isDirectScript(import.meta.url, 'ingest.ts') || isDirectScript(import.meta.url, 'ingest.js')) {
  void script();
}
