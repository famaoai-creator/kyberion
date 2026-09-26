#!/usr/bin/env node
/**
 * scripts/ingest.ts — DA-05 explicit ingest ceremony CLI (案7 Hybrid
 * Sovereign Ledger). Drives the ingest-actuator handlers in-process:
 *
 *   parse_document → normalize_card → dedup (check) → ingest:commit → dedup (register)
 *
 * There is deliberately no auto-ingest / watch mode — an operator (or a
 * mission task) invokes this once per document, and the who/when/why is
 * recorded in the tenant's information-asset ledger
 * (knowledge/confidential/{tenant}/_ledger/assets.jsonl).
 *
 * Usage:
 *   pnpm ingest --tenant <slug> --file <path> [--format docx|pdf|xlsx|pptx|html|slack_thread|markdown|text] [--ocr]
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
import {
  deriveAssetId,
  findAssetBySource,
  tenantIngestKnowledgeRoot,
} from '@agent/core/ingest-asset-ledger';
import { proposeTierPlacement } from '@agent/core/ingest-tier-gate';
import { scanContent } from '@agent/core/pii-scrubber';
import { pathResolver } from '@agent/core/path-resolver';
import { tenantProfilePath } from '@agent/core/tenant-registry';
import { validateReadPermission } from '@agent/core/tier-guard';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  commitIngest,
  dedupContent,
  normalizeCard,
  parseDocument,
  type IngestFormat,
} from '../libs/actuators/ingest-actuator/src/index.js';

const FORMATS: IngestFormat[] = [
  'docx',
  'pdf',
  'xlsx',
  'pptx',
  'html',
  'slack_thread',
  'markdown',
  'text',
];
type Print = (value: unknown) => void;

const EXTENSION_FORMATS: Record<string, IngestFormat> = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
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
  --source-id <id>         Stable source id (default: the file name) — re-ingests of the
                           same source become supersede versions, so keep it stable
  --target <relative>      Landing path relative to the tenant knowledge root
                           (default: ingest/<file-stem>.md)
  --kind <kind>            knowledge-card kind for taxonomy defaults (default: reference)
  --approval-id <id>       Approval reference recorded in the ledger
  --ingested-by <who>      Ceremony identity (default: KYBERION_PERSONA, then MISSION_ROLE;
                           refused when none is resolvable)
  --ocr                    pptx/pdf/docx: OCR embedded images with local providers (pasted figures/tables)
  --reparse                Re-parse an already-ingested, unchanged source (e.g. after a reader
                           improvement) and supersede its card; refused for any other duplicate
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
  ocr: boolean;
  sourcePublic: boolean;
  stewardApprovalId?: string;
  overrideRules?: string;
  overrideReason?: string;
  overrideApprovedBy?: string;
  dryRun: boolean;
  reparse: boolean;
  rootDir?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    reparse: false,
    help: false,
    proposeTier: false,
    ocr: false,
    sourcePublic: false,
  };
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
      case '--ocr':
        args.ocr = true;
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
      case '--reparse':
        args.reparse = true;
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

/**
 * Fail fast — and without a policy violation — when the current identity
 * cannot read what the ceremony needs (tenant profile + tenant knowledge
 * root). Repeated denied reads trip the kill switch, so the check uses the
 * pure permission evaluator and says exactly how to run instead.
 */
function assertCeremonyIdentity(tenant: string): void {
  if (tenant === 'common') return;
  const profile = tenantProfilePath(tenant);
  const decision = validateReadPermission(profile);
  if (decision.allowed) return;
  throw new Error(
    `the current identity cannot read the tenant profile (${path.relative(pathResolver.rootDir(), profile)}): ` +
      `${String(decision.reason || 'denied').replace(/[.\s]+$/, '')}. Run the ceremony as ` +
      '`KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=mission_controller pnpm ingest …`. ' +
      'Nothing was read or written.'
  );
}

function listTenantFolders(tenant: string, pathOptions: { rootDir?: string }): string[] {
  try {
    const root = path.join(
      pathOptions.rootDir ?? pathResolver.rootDir(),
      tenantIngestKnowledgeRoot(tenant, pathOptions)
    );
    return safeReaddir(root)
      .filter((name: string) => !name.startsWith('_') && !name.startsWith('.'))
      .filter((name: string) => {
        try {
          return safeLstat(path.join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function resolveIdentity(args: CliArgs): string {
  const explicit = String(args.ingestedBy || '').trim();
  if (explicit) return explicit;
  const persona = String(getRegisteredEnvText('KYBERION_PERSONA') || '').trim();
  if (persona) return persona;
  const role = String(getRegisteredEnvText('MISSION_ROLE') || '').trim();
  if (role) return role;
  throw new Error(
    'no ingest identity — pass --ingested-by <who> or run with KYBERION_PERSONA / MISSION_ROLE set. ' +
      'The ledger records WHO performed every ingest; anonymous ingests are refused.'
  );
}

export async function main(argv: string[] = [], print: Print = () => undefined): Promise<void> {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    print(USAGE);
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
  if (!args.rootDir) assertCeremonyIdentity(args.tenant);
  const sourceSystem = String(args.sourceSystem || 'file').trim();
  // Default to the file NAME, not its path: the same document staged in a
  // different tmp dir must still map to the same asset (supersede, not fork).
  const sourceId = String(args.sourceId || path.basename(absFile)).trim();
  const fileStem = path.basename(absFile, path.extname(absFile));
  const relativeTarget = args.target || `ingest/${fileStem}.md`;
  // In fixture mode the dedup registry moves under the fixture root too, so
  // a --root-dir run never pollutes the real shared registry.
  const registryPath = args.rootDir
    ? path.join(rootDir, 'active/shared/runtime/ingest/content-hash-registry.jsonl')
    : undefined;

  print(`[ingest] tenant=${args.tenant} file=${absFile} format=${format}`);
  print(`[ingest] source=${sourceSystem}::${sourceId} ingested_by=${ingestedBy}`);

  // 1. parse_document — raw bytes → unified IR (content_sha256 over raw bytes).
  const ir = await parseDocument({
    source_path: absFile,
    format,
    ...(args.ocr ? { ocr: true } : {}),
    source_meta: {
      source_system: sourceSystem,
      source_id: sourceId,
      retrieved_at: nowIso(),
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
    print('[ingest] tier placement proposal (advisory — steward approval decides):');
    print(JSON.stringify(proposal, null, 2));
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

  // 3. dedup — check-only here. The content hash is registered only after the
  // commit lands (step 5): registering first left a "seen" row behind whenever
  // the commit failed, so the fixed re-ingest was misreported as a duplicate.
  const dedupInput = {
    content_sha256: ir.meta.content_sha256,
    source_system: sourceSystem,
    source_id: sourceId,
    target_path: normalized.target_path,
    ...(registryPath ? { registry_path: registryPath } : {}),
  };
  const dedupCheck = dedupContent({ ...dedupInput, register: false });

  const assetId = deriveAssetId(sourceSystem, sourceId);
  const prior = findAssetBySource(args.tenant, sourceSystem, sourceId, pathOptions);

  // --reparse: the raw bytes are unchanged but the reader improved. Allowed
  // only for the SAME source whose ledger head holds these exact bytes, so it
  // can never be used to slip a different document past dedup.
  if (args.reparse && dedupCheck.duplicate) {
    if (!prior || prior.content_sha256 !== ir.meta.content_sha256) {
      throw new Error(
        '--reparse only applies to a source already ingested with identical content ' +
          `(${sourceSystem}::${sourceId} has no matching ledger record).`
      );
    }
  }
  const reparsing = args.reparse && dedupCheck.duplicate;
  const dedup = reparsing ? { ...dedupCheck, duplicate: false } : dedupCheck;
  const transformChain = [
    `parse_document:${format}`,
    'normalize_card',
    ...(reparsing ? ['reparse'] : []),
  ];

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
      transform_chain: transformChain,
      pii_findings: scan.findings,
      frontmatter: normalized.frontmatter,
      existing_folders: listTenantFolders(args.tenant, pathOptions),
    };
    print('[ingest] DRY RUN — no card written, no ledger record appended');
    if (!args.target && !prior) {
      print(
        `[ingest] no --target given: the card would land in ingest/. Existing folders in ${args.tenant}: ` +
          (plan.existing_folders.join(', ') || '(none)')
      );
    }
    print(JSON.stringify(plan, null, 2));
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
    transform_chain: transformChain,
    path_options: pathOptions,
  });

  if (!result.committed) {
    print(`[ingest] NOT committed (${result.reason}) — the ledger is unchanged`);
    print(JSON.stringify(result, null, 2));
    return;
  }
  // 5. register the content hash now that the card and ledger record exist.
  dedupContent({ ...dedupInput, target_path: result.target_path, register: true });
  print(`[ingest] committed ${result.provenance_ref} → ${result.target_path}`);
  print(JSON.stringify(result.asset, null, 2));
}

const script = defineScript({
  name: 'ingest',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (isDirectScript(import.meta.url, 'ingest.ts') || isDirectScript(import.meta.url, 'ingest.js')) {
  void script();
}
