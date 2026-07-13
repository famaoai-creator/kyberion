/**
 * LC-02 (LOOP_CLOSURE_PLAN): promote a successful one-off ADF run into a
 * reusable pipelines/ pipeline.
 *
 * Doctrine: get the work to SUCCESS first (ad-hoc ADF, repaired in place if
 * needed); promote only when reuse is expected. This tool makes that
 * promotion a one-command step instead of manual re-authoring:
 *
 *   pnpm pipeline:promote --input active/shared/tmp/my-run.json \
 *     [--name <slug>] [--trace <traceId>] [--dry-run] [--no-llm] [--force]
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
 */
import {
  logger,
  pathResolver,
  getReasoningBackend,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  slugify,
  tryRepairJson,
  validatePipelineAdf,
  validatePipelineGuardrails,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import * as nodePath from 'node:path';

interface PromotionAdvice {
  name?: string;
  description?: string;
  placeholders?: Array<{ step_index: number; param_path: string; placeholder: string }>;
  semantic_step_indices?: number[];
  rationale?: string;
}

function getFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
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
  if (cursor == null || typeof cursor !== 'object' || !(leafKey in cursor)) return false;
  cursor[leafKey] = value;
  return true;
}

async function requestPromotionAdvice(pipeline: any): Promise<PromotionAdvice | null> {
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
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryRepairJson(jsonText);
    }
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PromotionAdvice;
  } catch (err: any) {
    logger.warn(`[promote] advisory pass failed (promoting verbatim): ${err?.message || err}`);
    return null;
  }
}

function appendCatalogRow(slug: string, description: string, dryRun: boolean): void {
  const readmePath = pathResolver.rootResolve('pipelines/README.md');
  if (!safeExistsSync(readmePath)) return;
  let content = String(safeReadFile(readmePath, { encoding: 'utf8' }));
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputPath = getFlag(argv, '--input');
  if (!inputPath) {
    logger.error(
      'Usage: pipeline_promote --input <adf.json> [--name <slug>] [--trace <traceId>] [--dry-run] [--no-llm] [--force]'
    );
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const noLlm = argv.includes('--no-llm');
  const force = argv.includes('--force');
  const traceId = getFlag(argv, '--trace');

  const resolvedInput = pathResolver.rootResolve(inputPath);
  if (!safeExistsSync(resolvedInput)) {
    logger.error(`[promote] source ADF not found: ${resolvedInput}`);
    process.exit(1);
  }
  const raw = String(safeReadFile(resolvedInput, { encoding: 'utf8' }));
  const source = JSON.parse(raw);

  // 1. Preflight the source exactly like run_pipeline would.
  const pipeline: any = validatePipelineAdf(source);
  const sourceGuardrails = validatePipelineGuardrails(pipeline, inputPath);
  if (!sourceGuardrails.ok) {
    logger.error(
      `[promote] source ADF fails guardrails — fix it (or run it to success) before promoting:\n${sourceGuardrails.findings
        .map((finding) => `  - [${finding.severity}] ${finding.code}: ${finding.message}`)
        .join('\n')}`
    );
    process.exit(1);
  }

  // 2. Advisory pass (placeholders + semantic flags).
  const advice = noLlm ? null : await requestPromotionAdvice(pipeline);
  const appliedPlaceholders: string[] = [];
  if (advice?.placeholders) {
    for (const entry of advice.placeholders) {
      const step = pipeline.steps?.[entry.step_index];
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
        step._semantic = true; // marker: this step needs fresh model judgment — do not hand-freeze its params
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
    promoted_at: new Date().toISOString(),
    ...(traceId ? { trace_id: traceId } : {}),
    ...(advice?.rationale ? { rationale: String(advice.rationale).slice(0, 500) } : {}),
    ...(advice
      ? {}
      : { note: 'verbatim promotion (no advisory pass) — review placeholders manually' }),
  };

  // 4. Re-validate the transformed pipeline and write it out.
  const promoted = validatePipelineAdf(pipeline);
  const promotedGuardrails = validatePipelineGuardrails(promoted, `pipelines/${slug}.json`);
  if (!promotedGuardrails.ok) {
    logger.error('[promote] transformed pipeline fails guardrails — aborting (source untouched).');
    process.exit(1);
  }
  const targetPath = pathResolver.rootResolve(`pipelines/${slug}.json`);
  if (safeExistsSync(targetPath) && !force) {
    logger.error(`[promote] pipelines/${slug}.json already exists — use --force to overwrite.`);
    process.exit(1);
  }
  if (dryRun) {
    logger.info(`[promote] (dry-run) would write pipelines/${slug}.json`);
  } else {
    // Catalog writes run under the same authority role as registry generation
    // (see role-write-access.json: ecosystem_architect owns pipelines/).
    withExecutionContext('ecosystem_architect', () => {
      safeWriteFile(targetPath, `${JSON.stringify(promoted, null, 2)}\n`);
    });
    logger.success(`✅ [promote] wrote pipelines/${slug}.json`);
  }
  if (appliedPlaceholders.length > 0) {
    logger.info(
      `[promote] placeholders:\n${appliedPlaceholders.map((line) => `  - ${line}`).join('\n')}`
    );
    logger.info(
      '[promote] run with: pnpm pipeline --input pipelines/' +
        slug +
        '.json --context \'{"<placeholder>": "<value>"}\''
    );
  }
  appendCatalogRow(slug, description, dryRun);
}

main().catch((err) => {
  logger.error(`[promote] ${err?.message || err}`);
  process.exit(1);
});
