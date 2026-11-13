/**
 * HR-01 tenant hearing templates: `template put / list / show`.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 * A tenant sets its own hearing goals by writing templates under
 * `knowledge/confidential/<tenant>/decisions/_templates/<id>.json`, only
 * through this verb. `draft --template <id>` then uses the tenant's template
 * before the product one of that id (except fixed-purpose product templates
 * such as `bolt-review`, which a tenant cannot shadow).
 *
 * `put` takes no approval: a template is never shown to a customer by itself.
 * An agenda drafted from it reaches a customer only after `submit` approves
 * that agenda's content hash, and a later template change never alters an
 * agenda that already exists. The write is schema-validated, bound to the
 * process's tenant (`tenantOf`) and audited.
 *
 * Concept: knowledge/product/architecture/hearing-model.md.
 */
import { readJson } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import {
  PRODUCT_ONLY_TEMPLATE_IDS,
  TEMPLATE_ID_PATTERN,
  listDecisionTemplates,
  resolveDecisionTemplate,
  validateDecisionTemplate,
  writeTenantTemplateRecord,
  type DecisionTemplate,
} from '@agent/core/customer-decision';
import { ScriptExitError } from '../lib/harness.js';
import {
  asLedgerWriter,
  audit,
  memberActorId,
  requireOpt,
  tenantOf,
  usageError,
} from './common.js';

/** Counts only: the operator reads the text with `template show`. */
function templateSummary(template: DecisionTemplate): Record<string, unknown> {
  return {
    template_id: template.template_id,
    version: template.version,
    phase: template.phase,
    entries: template.entries.length,
    has_objective: template.objective !== undefined,
  };
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\[([A-Z0-9_]+)\]/u)?.[1] ?? 'CUSTOMER_DECISION_TEMPLATE_INVALID';
}

/** `template put --tenant <t> --file <template.json> --by user:<member>` */
function runTemplatePut(opts: Record<string, string>): unknown {
  const tenant = tenantOf(opts);
  const by = memberActorId(opts.by);
  const file = assertSafeRepositoryPath(requireOpt(opts, 'file'));
  if (!safeExistsSync(file)) throw new ScriptExitError(2, `template file not found: ${opts.file}`);
  const record = readJson<unknown>(file);
  const templateId =
    record && typeof record === 'object' && 'template_id' in record
      ? String((record as { template_id: unknown }).template_id)
      : '';
  if (!TEMPLATE_ID_PATTERN.test(templateId))
    throw new ScriptExitError(2, '[CUSTOMER_DECISION_TEMPLATE_ID_INVALID] invalid template_id');
  if (opts.template !== undefined && opts.template !== templateId)
    throw new ScriptExitError(
      2,
      `[CUSTOMER_DECISION_TEMPLATE_ID_MISMATCH] --template ${opts.template} differs from the file's template_id ${templateId}`
    );
  if (PRODUCT_ONLY_TEMPLATE_IDS.includes(templateId))
    throw new ScriptExitError(
      2,
      `[CUSTOMER_DECISION_TEMPLATE_RESERVED] ${templateId} is a fixed product template; choose another template_id`
    );
  let template: DecisionTemplate;
  try {
    template = validateDecisionTemplate(record, templateId);
  } catch (error) {
    throw new ScriptExitError(
      2,
      `[${diagnostic(error)}] the template does not match customer-decision-template.schema.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const written = asLedgerWriter(tenant, () =>
    writeTenantTemplateRecord(tenant, templateId, template)
  );
  audit(tenant, 'template_put', {
    template_id: templateId,
    version: template.version,
    entries: template.entries.length,
    has_objective: template.objective !== undefined,
    by,
  });
  return { ...templateSummary(template), origin: 'tenant', path: written };
}

/** `template list --tenant <t>` */
function runTemplateList(opts: Record<string, string>): unknown {
  const tenant = tenantOf(opts);
  return { templates: asLedgerWriter(tenant, () => listDecisionTemplates(tenant)) };
}

/** `template show --tenant <t> --template <id>` — the template a draft of this id would use. */
function runTemplateShow(opts: Record<string, string>): unknown {
  const tenant = tenantOf(opts);
  const templateId = requireOpt(opts, 'template');
  const { template, origin } = asLedgerWriter(tenant, () =>
    resolveDecisionTemplate(templateId, { tenantSlug: tenant })
  );
  return { origin, template };
}

export function runTemplate(action: string | undefined, opts: Record<string, string>): unknown {
  switch (action) {
    case 'put':
      return runTemplatePut(opts);
    case 'list':
      return runTemplateList(opts);
    case 'show':
      return runTemplateShow(opts);
    default:
      throw usageError(`template needs put, list or show (got '${action ?? ''}')`);
  }
}
