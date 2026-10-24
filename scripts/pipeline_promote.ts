/**
 * LC-02 (LOOP_CLOSURE_PLAN): promote a successful one-off ADF run into a
 * reusable pipelines/ pipeline.
 *
 * Doctrine: get the work to SUCCESS first (ad-hoc ADF, repaired in place if
 * needed); promote only when reuse is expected. This tool makes that
 * promotion a one-command step instead of manual re-authoring:
 *
 *   pnpm pipeline:promote --input active/shared/tmp/my-run.json \
 *     [--name <slug>] [--tenant <slug> | --source-is-public] [--trace <traceId>] [--dry-run] [--no-llm] [--force]
 *
 * --tenant <slug>: land the pipeline in the tenant catalog
 * (knowledge/confidential/<slug>/pipelines/<name>.json + that directory's
 * README.md row) instead of public pipelines/. The slug is validated against
 * the tenant registry. Without --tenant a source under a personal/confidential
 * tier or a tenant-partitioned floor path is refused (it would downgrade the
 * data into the public catalog), and so is unpartitioned scratch
 * (`active/shared/tmp/<job>/…`, tier unknown) unless --source-is-public
 * acknowledges that its content is public.
 *
 * Scope: successful one-off ADF pipeline runs → reusable pipelines/*.json.
 * For browser recordings (Pattern A→B into ProcedureCatalog), use the
 * `promote-procedure` pipeline instead — different input, different catalog.
 *
 * What it does:
 *   1. validate the source ADF (schema + guardrails — same preflight as run)
 *   2. optionally ask the reasoning backend ONE advisory question: which
 *      param values should become {{placeholders}} (run-specific inputs) and
 *      which steps are semantic briefs that must not be frozen. Deterministic
 *      fallback: promote verbatim with a TODO note (stub backend / --no-llm).
 *   3. stamp provenance (source path, trace id, promoted_at)
 *   4. re-validate the result, write pipelines/<slug>.json, and append a
 *      catalog row to pipelines/README.md ("Promoted" section)
 *   5. tenant mode only (not --dry-run): append a line to the tenant
 *      information-asset ledger (`_ledger/assets.jsonl`, source_system `adf`,
 *      content hash of the written pipeline file), returned as `asset`
 */
import { getReasoningBackend } from '@agent/core/reasoning/reasoning-backend';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  isRecord,
  nowIso,
  parseSafeJsonInput,
  readJsonIfPresent,
  readTextFile,
  slugify,
  writeJson,
} from '@agent/core/foundation';
import { tryRepairJson } from '@agent/core/json-repair';
import {
  loadPipelineAdfAtPath,
  validatePipelineAdf,
  type PipelineAdf,
  type PipelineAdfStep,
} from '@agent/core/pipeline/pipeline-contract';
import { validatePipelineGuardrails } from '@agent/core/pipeline/adf-guardrails';
import { withExecutionContext } from '@agent/core/governance';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import * as nodePath from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, hasCliFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { assertPromotionSourceScope, repoRelative } from './lib/promotion-scope.js';
import {
  PIPELINE_PROMOTE_SOURCE_SYSTEM,
  commitPromotionAsset,
  planPromotionAsset,
  promotionAssetSummary,
  resolvePromotionActor,
  sha256Text,
} from './lib/promotion-ledger.js';

interface PromotionAdvice {
  name?: string;
  description?: string;
  placeholders?: Array<{ step_index: number; param_path: string; placeholder: string }>;
  semantic_step_indices?: number[];
  rationale?: string;
}

type PromotablePipeline = PipelineAdf & {
  promotion?: Record<string, unknown>;
};

type PromotableStep = PipelineAdfStep & { _semantic?: boolean };

export function readPipelinePromotionTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function normalizePromotionAdvice(value: unknown): PromotionAdvice | null {
  if (!isRecord(value)) return null;
  const placeholders = Array.isArray(value.placeholders)
    ? value.placeholders.flatMap((entry): PromotionAdvice['placeholders'] => {
        if (!isRecord(entry)) return [];
        if (
          typeof entry.step_index !== 'number' ||
          !Number.isSafeInteger(entry.step_index) ||
          entry.step_index < 0 ||
          typeof entry.param_path !== 'string' ||
          !entry.param_path.trim() ||
          typeof entry.placeholder !== 'string' ||
          !entry.placeholder.trim()
        ) {
          return [];
        }
        return [
          {
            step_index: entry.step_index,
            param_path: entry.param_path.trim(),
            placeholder: entry.placeholder.trim(),
          },
        ];
      })
    : undefined;
  const semanticStepIndices = Array.isArray(value.semantic_step_indices)
    ? value.semantic_step_indices.filter(
        (entry): entry is number =>
          typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0
      )
    : undefined;
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(placeholders ? { placeholders } : {}),
    ...(semanticStepIndices ? { semantic_step_indices: semanticStepIndices } : {}),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
  };
}

function getFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function resolvePromotionInputPath(inputPath: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(inputPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`[promote] source ADF must be an existing regular file: ${inputPath}`);
  }
  return resolved;
}

/** The governed run command for a tenant pipeline (needs a project-trust approval). */
export function tenantPipelineRunCommand(targetRepoPath: string): string {
  return `pnpm pipeline --input ${targetRepoPath} --project-trust-approval <id>`;
}

/**
 * Next steps after a tenant promotion. Tenant pipelines are project-local:
 * they run only with a human-approved, content-bound project-trust decision,
 * so every promotion (including a --force re-promotion) needs a new one.
 */
export function tenantPipelineNextSteps(targetRepoPath: string): string[] {
  return [
    `pnpm kyberion project-trust request ${targetRepoPath}`,
    'a human approves the request (approval is bound to this exact content; re-request after every change)',
    tenantPipelineRunCommand(targetRepoPath),
  ];
}

/** Tenant catalog README content with one more pipeline row (idempotent per slug). */
export function buildTenantPipelineCatalog(
  existing: string | null,
  tenant: string,
  row: { slug: string; command: string; description: string }
): string | null {
  const line = `| \`${row.slug}\` | \`${row.command}\` | ${row.description.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`;
  if (existing === null) {
    return [
      '---',
      `title: '${tenant} pipelines'`,
      `tags: [pipelines, tenant, ${tenant}]`,
      `last_updated: ${nowIso().slice(0, 10)}`,
      '---',
      '',
      `# ${tenant} pipelines`,
      '',
      `Tenant-scoped pipelines promoted with \`pnpm pipeline:promote --tenant ${tenant}\`. Provenance is recorded in each file under \`promotion\`.`,
      '',
      'Tenant pipelines are project-local and need a project-trust approval before they run: `pnpm kyberion project-trust request <path>`, a human approves it, then run with `--project-trust-approval <id>`. The approval is bound to the file content — re-request after every change, including a re-promotion.',
      '',
      '| Pipeline | Run | Description |',
      '| --- | --- | --- |',
      line,
      '',
    ].join('\n');
  }
  if (existing.includes(`| \`${row.slug}\``)) return null;
  const lines = existing.split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('|')) insertAt = i + 1;
  if (insertAt < 0) {
    return `${existing.replace(/\n*$/, '')}\n\n| Pipeline | Run | Description |\n| --- | --- | --- |\n${line}\n`;
  }
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

/** Set a dotted path (e.g. "url" or "args.0") inside a params object. */
function setParamPath(params: Record<string, unknown>, paramPath: string, value: string): boolean {
  const segments = paramPath.split('.');
  let cursor: any = params;
  for (let i = 0; i < segments.length - 1; i++) {
    const key: string | number = /^\d+$/.test(segments[i]) ? Number(segments[i]) : segments[i];
    if (cursor == null || typeof cursor !== 'object') return false;
    cursor = cursor[key];
  }
  const leaf = segments[segments.length - 1];
  const leafKey: string | number = /^\d+$/.test(leaf) ? Number(leaf) : leaf;
  // Prototype-pollution guard: never write into prototype-chain keys.
  if (leafKey === '__proto__' || leafKey === 'constructor' || leafKey === 'prototype') {
    return false;
  }
  if (cursor == null || typeof cursor !== 'object' || !(leafKey in cursor)) return false;
  cursor[leafKey] = value;
  return true;
}

async function requestPromotionAdvice(pipeline: PipelineAdf): Promise<PromotionAdvice | null> {
  const backend = getReasoningBackend();
  if (backend.name === 'stub') {
    logger.warn('[promote] reasoning backend is stub — skipping advisory pass (verbatim copy).');
    return null;
  }
  const prompt = [
    'You are reviewing a Kyberion pipeline ADF that just ran successfully once, to promote it into a reusable catalog pipeline.',
    'Identify (a) param values that are run-specific inputs and should become {{placeholder}} variables resolved from --context at run time,',
    'and (b) steps whose outcome depends on fresh model judgment (semantic steps) — these must NOT be frozen into deterministic form.',
    'Do not invent steps. Do not rename ops. Only report what should be parameterized or flagged.',
    '',
    'Pipeline ADF:',
    JSON.stringify(pipeline, null, 2).slice(0, 16000),
    '',
    'Reply with ONLY a JSON object:',
    '{ "name": string (kebab-case slug), "description": string (one line, English),',
    '  "placeholders": [{ "step_index": number, "param_path": string, "placeholder": string }],',
    '  "semantic_step_indices": number[], "rationale": string }',
  ].join('\n');
  try {
    const raw = String(await backend.prompt(prompt));
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(jsonText, 'pipeline promotion advice');
    } catch {
      const repaired = tryRepairJson(jsonText);
      parsed =
        repaired === null
          ? null
          : parseSafeJsonInput(JSON.stringify(repaired), 'pipeline promotion advice');
    }
    return normalizePromotionAdvice(parsed);
  } catch (err: unknown) {
    logger.warn(
      `[promote] advisory pass failed (promoting verbatim): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function appendCatalogRow(slug: string, description: string, dryRun: boolean): void {
  const readmePath = pathResolver.rootResolve('pipelines/README.md');
  if (!safeExistsSync(readmePath)) return;
  let content = readPipelinePromotionTextFile(readmePath);
  const row = `| \`${slug}\` | \`pnpm pipeline --input pipelines/${slug}.json\` | ${description} |`;
  if (content.includes(`| \`${slug}\``)) return;
  const sectionHeader = '### Promoted (pipeline:promote)';
  if (!content.includes(sectionHeader)) {
    const block = [
      '',
      sectionHeader,
      '',
      'Pipelines promoted from successful one-off runs (LC-02). Provenance is recorded in each file under `promotion`.',
      '',
      '| Pipeline | pnpm shortcut | Description |',
      '| --- | --- | --- |',
      row,
      '',
    ].join('\n');
    // Insert before the Fragments section to stay inside "System Pipelines".
    const anchor = '## Fragments';
    content = content.includes(anchor)
      ? content.replace(anchor, `${block}\n${anchor}`)
      : `${content}\n${block}`;
  } else {
    content = content.replace(sectionHeader, sectionHeader); // no-op guard
    const lines = content.split('\n');
    const headerIndex = lines.findIndex((line) => line.includes(sectionHeader));
    let insertAt = headerIndex + 1;
    for (let i = headerIndex + 1; i < lines.length; i++) {
      if (lines[i].startsWith('|')) insertAt = i + 1;
      else if (lines[i].startsWith('##')) break;
    }
    lines.splice(insertAt, 0, row);
    content = lines.join('\n');
  }
  if (dryRun) {
    logger.info(`[promote] (dry-run) would append catalog row: ${row}`);
    return;
  }
  const finalContent = content;
  withExecutionContext('ecosystem_architect', () => {
    safeWriteFile(readmePath, finalContent);
  });
  logger.info(`[promote] catalog row appended to pipelines/README.md`);
}

function fail(message: string): never {
  logger.error(message);
  throw new ScriptExitError(1, '', true);
}

export interface PipelinePromotionResult {
  target: string;
  dry_run: boolean;
  tenant?: string;
  next_steps: string[];
  /** Tenant asset-ledger entry for the written pipeline (tenant, non-dry-run only). */
  asset?: ReturnType<typeof promotionAssetSummary>;
}

/**
 * Re-promoting identical content keeps the earlier `promotion.promoted_at`, so
 * the pipeline file is byte-identical and its ledger content hash matches.
 */
export function keepPipelinePromotedAtWhenUnchanged<T extends { promotion?: unknown }>(
  previous: unknown,
  next: T
): T {
  if (!isRecord(previous) || !isRecord(previous.promotion) || !isRecord(next.promotion)) {
    return next;
  }
  const promotedAt = previous.promotion.promoted_at;
  if (typeof promotedAt !== 'string') return next;
  const withoutTime = (value: Record<string, unknown>) =>
    JSON.stringify({ ...value, promotion: { ...(value.promotion as object), promoted_at: '' } });
  return withoutTime(previous) === withoutTime(next as unknown as Record<string, unknown>)
    ? { ...next, promotion: { ...next.promotion, promoted_at: promotedAt } }
    : next;
}

/**
 * The promotion itself, for governed callers that install a known template
 * into a tenant catalog (`customer-decision reminders --install`, CD-11).
 * Same argv as the CLI; throws `ScriptExitError` on refusal. `ingestedBy`
 * names the operator who asked (e.g. `user:<member>` from the caller's own
 * `--by`) for the tenant asset ledger, instead of the process identity.
 */
export async function promotePipelineAdf(
  args: string[],
  options: { ingestedBy?: string } = {}
): Promise<PipelinePromotionResult> {
  return main(args, options);
}

async function main(
  args: string[] = [],
  options: { ingestedBy?: string } = {}
): Promise<PipelinePromotionResult> {
  const argv = args;
  const inputPath = getFlag(argv, '--input');
  if (!inputPath) {
    fail(
      '[promote] missing --input — pipeline:promote needs the ADF to promote | ' +
        'pnpm pipeline:promote --input <adf.json> [--name <slug>] [--tenant <slug> | --source-is-public] [--trace <traceId>] [--dry-run] [--no-llm] [--force] ' +
        '(ADF pipeline runs only; browser recordings use the promote-procedure pipeline) | evidence: argv'
    );
  }
  const dryRun = hasCliFlag(argv, '--dry-run');
  const noLlm = hasCliFlag(argv, '--no-llm');
  const force = hasCliFlag(argv, '--force');
  const traceId = getFlag(argv, '--trace');
  const tenant = getFlag(argv, '--tenant')?.trim().toLowerCase();

  // 0. Tier guard (lexical, before any disk access): never move tier- or
  // tenant-bound data into a lower catalog or another tenant.
  let tenantKnowledgeRoot: string | undefined;
  let resolvedInput = '';
  try {
    assertPromotionSourceScope(
      repoRelative(pathResolver.rootResolve(inputPath)),
      tenant,
      'pipeline:promote',
      { sourceIsPublic: hasCliFlag(argv, '--source-is-public') }
    );
    if (tenant) {
      // Fail closed on an unregistered or inactive tenant (DA-01 spine); the
      // source is then read under the same tenant-bound role.
      tenantKnowledgeRoot = withExecutionContext(
        'asset_promoter',
        () => resolveTenant(tenant).knowledge_root,
        undefined,
        tenant
      );
      resolvedInput = withExecutionContext(
        'asset_promoter',
        () => resolvePromotionInputPath(inputPath),
        undefined,
        tenant
      );
    } else {
      resolvedInput = resolvePromotionInputPath(inputPath);
    }
  } catch (err: unknown) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // 1. Preflight the source exactly like run_pipeline would.
  const pipeline: PromotablePipeline = {
    ...(tenant
      ? withExecutionContext(
          'asset_promoter',
          () => loadPipelineAdfAtPath(resolvedInput),
          undefined,
          tenant
        )
      : loadPipelineAdfAtPath(resolvedInput)),
  };
  const sourceGuardrails = validatePipelineGuardrails(pipeline, inputPath);
  if (!sourceGuardrails.ok) {
    fail(
      `[promote] source ADF fails guardrails — fix it (or run it to success) before promoting:\n${sourceGuardrails.findings
        .map((finding) => `  - [${finding.severity}] ${finding.code}: ${finding.message}`)
        .join('\n')}`
    );
  }

  // 2. Advisory pass (placeholders + semantic flags).
  const advice = noLlm ? null : await requestPromotionAdvice(pipeline);
  const appliedPlaceholders: string[] = [];
  if (advice?.placeholders) {
    for (const entry of advice.placeholders) {
      const step = pipeline.steps[entry.step_index];
      if (!step || typeof step !== 'object') continue;
      const placeholder = `{{${String(entry.placeholder).replace(/[^\w.]/g, '_')}}}`;
      if (setParamPath(step.params ?? {}, entry.param_path, placeholder)) {
        appliedPlaceholders.push(
          `steps[${entry.step_index}].params.${entry.param_path} → ${placeholder}`
        );
      }
    }
  }
  if (advice?.semantic_step_indices) {
    for (const index of advice.semantic_step_indices) {
      const step = pipeline.steps?.[index];
      if (step && typeof step === 'object') {
        (step as PromotableStep)._semantic = true; // marker: this step needs fresh model judgment — do not hand-freeze its params
      }
    }
  }

  const slug = slugify(
    getFlag(argv, '--name') ||
      advice?.name ||
      pipeline.name ||
      nodePath.basename(inputPath, '.json')
  );
  const description = advice?.description || pipeline.description || `Promoted from ${inputPath}`;

  // 3. Provenance.
  pipeline.name = pipeline.name || slug;
  pipeline.description = description;
  pipeline.promotion = {
    promoted_from: inputPath,
    promoted_at: nowIso(),
    ...(traceId ? { trace_id: traceId } : {}),
    ...(advice?.rationale ? { rationale: String(advice.rationale).slice(0, 500) } : {}),
    ...(advice
      ? {}
      : { note: 'verbatim promotion (no advisory pass) — review placeholders manually' }),
  };

  if (tenant) pipeline.promotion = { ...pipeline.promotion, tenant_slug: tenant };

  // 4. Re-validate the transformed pipeline and write it out.
  const catalogDir = tenantKnowledgeRoot ? `${tenantKnowledgeRoot}/pipelines` : 'pipelines';
  const targetRepoPath = `${catalogDir}/${slug}.json`;
  const promoted = validatePipelineAdf(pipeline);
  const promotedGuardrails = validatePipelineGuardrails(promoted, targetRepoPath);
  if (!promotedGuardrails.ok) {
    fail('[promote] transformed pipeline fails guardrails — aborting (source untouched).');
  }
  const targetPath = assertSafeRepositoryPath(pathResolver.rootResolve(targetRepoPath), {
    allowMissingLeaf: true,
  });
  if (tenant && tenantKnowledgeRoot) {
    const knowledgeRoot = tenantKnowledgeRoot;
    const exists = withExecutionContext(
      'asset_promoter',
      () => safeExistsSync(targetPath),
      undefined,
      tenant
    );
    if (exists && !force) {
      fail(`[promote] ${targetRepoPath} already exists — use --force to overwrite.`);
    }
    let asset: PipelinePromotionResult['asset'];
    if (dryRun) {
      logger.info(`[promote] (dry-run) would write ${targetRepoPath}`);
    } else {
      // Tenant catalog writes run under the narrow asset_promoter role bound
      // to this tenant (security-policy.json grants only the tenant's own
      // pipelines/, tools/ and _ledger/ directories). The asset-ledger line
      // is planned before the write and appended right after it.
      const ledgerOptions = { knowledgeRoot };
      try {
        const ingestedBy = options.ingestedBy?.trim() || resolvePromotionActor('[promote]');
        asset = withExecutionContext(
          'asset_promoter',
          () => {
            const final = keepPipelinePromotedAtWhenUnchanged(
              exists ? readJsonIfPresent<unknown>(targetPath) : null,
              promoted as PromotablePipeline
            );
            const text = `${JSON.stringify(final, null, 2)}\n`;
            const plan = planPromotionAsset(
              {
                tenant,
                sourceSystem: PIPELINE_PROMOTE_SOURCE_SYSTEM,
                sourceId: repoRelative(resolvedInput),
                targetPath: targetRepoPath,
                contentSha256: sha256Text(text),
                transformChain: ['pipeline_promote'],
                ingestedBy,
                now: nowIso(),
                tag: '[promote]',
              },
              ledgerOptions
            );
            writeJson(targetPath, final);
            commitPromotionAsset(tenant, plan, ledgerOptions);
            return promotionAssetSummary(plan);
          },
          undefined,
          tenant
        );
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err));
      }
      logger.success(`✅ [promote] wrote ${targetRepoPath} (ledger ${asset?.ref})`);
    }
    logPlaceholders(appliedPlaceholders, tenantPipelineRunCommand(targetRepoPath));
    appendTenantCatalogRow(tenant, knowledgeRoot, slug, targetRepoPath, description, dryRun);
    // Every tenant promotion — first, --force re-promotion or dry run —
    // invalidates or precedes the content-bound project-trust approval.
    const nextSteps = tenantPipelineNextSteps(targetRepoPath);
    logger.info(
      `[promote] ${dryRun ? '(dry-run) ' : ''}next: ${nextSteps[0]} — ${nextSteps[1]}, then run with: ${nextSteps[2]}`
    );
    return {
      target: targetRepoPath,
      dry_run: dryRun,
      tenant,
      next_steps: nextSteps,
      ...(asset ? { asset } : {}),
    };
  }
  if (safeExistsSync(targetPath) && !force) {
    fail(`[promote] pipelines/${slug}.json already exists — use --force to overwrite.`);
  }
  if (dryRun) {
    logger.info(`[promote] (dry-run) would write pipelines/${slug}.json`);
  } else {
    // Catalog writes run under the same authority role as registry generation
    // (see role-write-access.json: ecosystem_architect owns pipelines/).
    withExecutionContext('ecosystem_architect', () => {
      writeJson(targetPath, promoted);
    });
    logger.success(`✅ [promote] wrote pipelines/${slug}.json`);
  }
  const runCommand = `pnpm pipeline --input pipelines/${slug}.json`;
  logPlaceholders(appliedPlaceholders, runCommand);
  appendCatalogRow(slug, description, dryRun);
  return { target: `pipelines/${slug}.json`, dry_run: dryRun, next_steps: [runCommand] };
}

function logPlaceholders(appliedPlaceholders: string[], runCommand: string): void {
  if (appliedPlaceholders.length === 0) return;
  logger.info(
    `[promote] placeholders:\n${appliedPlaceholders.map((line) => `  - ${line}`).join('\n')}`
  );
  logger.info(`[promote] run with: ${runCommand} --context '{"<placeholder>": "<value>"}'`);
}

/** Append the tenant catalog row; never touches the public pipelines/README.md. */
function appendTenantCatalogRow(
  tenant: string,
  knowledgeRoot: string,
  slug: string,
  targetRepoPath: string,
  description: string,
  dryRun: boolean
): void {
  const readmeRepoPath = `${knowledgeRoot}/pipelines/README.md`;
  const readmePath = pathResolver.rootResolve(readmeRepoPath);
  const existing = withExecutionContext(
    'asset_promoter',
    () => (safeExistsSync(readmePath) ? readPipelinePromotionTextFile(readmePath) : null),
    undefined,
    tenant
  );
  const next = buildTenantPipelineCatalog(existing, tenant, {
    slug,
    command: tenantPipelineRunCommand(targetRepoPath),
    description,
  });
  if (next === null) return;
  if (dryRun) {
    logger.info(`[promote] (dry-run) would update ${readmeRepoPath}`);
    return;
  }
  withExecutionContext('asset_promoter', () => safeWriteFile(readmePath, next), undefined, tenant);
  logger.info(`[promote] catalog row appended to ${readmeRepoPath}`);
}

/** CU-01: `--help` / typos exit before a pipeline or catalog row is written. */
export const PIPELINE_PROMOTE_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pipeline promote',
  manifestId: 'script.pipeline.promote',
  options: [
    { flag: '--input', value: '<adf.json>' },
    { flag: '--name', value: '<slug>' },
    { flag: '--tenant', value: '<tenant-slug>' },
    { flag: '--source-is-public' },
    { flag: '--trace', value: '<trace-id>' },
    { flag: '--dry-run' },
    { flag: '--no-llm' },
    { flag: '--force' },
  ],
};

export const runPipelinePromotion = defineScript({
  name: 'pipeline:promote',
  flags: [],
  run: async ({ argv, print }) => {
    if (guardCliArgs(argv, PIPELINE_PROMOTE_CLI, print)) return;
    return main(argv);
  },
});

if (
  isDirectScript(import.meta.url, 'pipeline_promote.ts') ||
  isDirectScript(import.meta.url, 'pipeline_promote.js')
)
  void runPipelinePromotion();
