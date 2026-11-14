/**
 * Customer decision templates (CD-03/04, HR-01): load a governed hearing
 * template and turn it into a draft agenda.
 *
 * A template comes from one of two places. Product templates
 * (`knowledge/product/orchestration/customer-decision-templates/<id>.json`)
 * write every text as a user-facing-vocabulary key. A tenant's own templates
 * (`knowledge/confidential/<tenant>/decisions/_templates/<id>.json`, written
 * only through `customer-decision template put`) write text inline per locale,
 * since a tenant cannot add vocabulary keys; given a tenant, its template of
 * an id is used before the product one. Fixed-purpose product templates
 * ({@link PRODUCT_ONLY_TEMPLATE_IDS}) are never shadowed. Text is resolved in
 * the agenda's locale when the template is instantiated; a missing locale is
 * an error, never another language or a rendered key.
 *
 * Concept: knowledge/product/architecture/hearing-model.md.
 */
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { t, type VocabularyKey } from '../localization/t.js';
import type {
  AgendaEntryKind,
  AgendaObjective,
  AgendaOptionImpact,
  DecisionAgenda,
} from './model.js';
import { AGENDA_ID_PATTERN } from './model.js';
import { listTenantTemplateIds, readTenantTemplateRecord } from './store.js';

/** Inline text per agenda locale (tenant templates). */
export type LocalizedText = { ja?: string; en?: string };

export interface DecisionTemplateEntry {
  entry_id: string;
  item: string;
  key: string;
  kind: AgendaEntryKind;
  question_key?: string;
  question?: LocalizedText;
  background_key?: string;
  background?: LocalizedText;
  options?: Array<{
    value: unknown;
    label_key?: string;
    label?: LocalizedText;
    impact_keys?: { cost: string; schedule: string; scope: string };
    impact?: { cost: LocalizedText; schedule: LocalizedText; scope: LocalizedText };
  }>;
  org_default?: { value: unknown; source: string };
  requires_customer: boolean;
}

/** HR-01: the hearing goal a template sets. */
export interface DecisionTemplateObjective {
  statement_key?: string;
  statement?: LocalizedText;
  success_criteria?: Array<string | LocalizedText>;
}

export interface DecisionTemplate {
  version: string;
  template_id: string;
  phase: string;
  title_key?: string;
  title?: LocalizedText;
  objective?: DecisionTemplateObjective;
  entries: DecisionTemplateEntry[];
}

/** Where a loaded template came from. */
export type DecisionTemplateOrigin = 'tenant' | 'product';

export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,80}$/u;
/** Product templates with a fixed purpose in the facade; a tenant template never shadows them. */
export const PRODUCT_ONLY_TEMPLATE_IDS: readonly string[] = ['bolt-review'];
const TEMPLATE_DIR = 'knowledge/product/orchestration/customer-decision-templates';
const TEMPLATE_SCHEMA = 'knowledge/product/schemas/customer-decision-template.schema.json';
const AGENDA_SCHEMA = 'knowledge/product/schemas/customer-decision-agenda.schema.json';

const templateCatalogs = new Map<string, GovernedCatalog<DecisionTemplate>>();
let agendaCatalog: GovernedCatalog<DecisionAgenda> | undefined;
let templateValidator: GovernedCatalog<DecisionTemplate> | undefined;

function assertTemplateId(templateId: string): void {
  if (typeof templateId !== 'string' || !TEMPLATE_ID_PATTERN.test(templateId))
    throw new Error('[CUSTOMER_DECISION_TEMPLATE_ID_INVALID] invalid template id');
}

/**
 * Validate a template record against the template schema (and its id against
 * the expected one). Used for tenant templates on read and on `template put`.
 */
export function validateDecisionTemplate(record: unknown, templateId: string): DecisionTemplate {
  assertTemplateId(templateId);
  if (!templateValidator) {
    const schemaPath = pathResolver.rootResolve(TEMPLATE_SCHEMA);
    templateValidator = defineCatalog<DecisionTemplate>({
      id: 'customer-decision-template-validator',
      path: schemaPath,
      schema: schemaPath,
    });
  }
  const template = templateValidator.validate(record);
  if (template.template_id !== templateId)
    throw new Error('[CUSTOMER_DECISION_TEMPLATE_ID_MISMATCH] template id does not match its file');
  return template;
}

function loadProductTemplate(templateId: string): DecisionTemplate {
  let catalog = templateCatalogs.get(templateId);
  if (!catalog) {
    catalog = defineCatalog<DecisionTemplate>({
      id: `customer-decision-template-${templateId}`,
      path: pathResolver.rootResolve(path.join(TEMPLATE_DIR, `${templateId}.json`)),
      schema: pathResolver.rootResolve(TEMPLATE_SCHEMA),
    });
    templateCatalogs.set(templateId, catalog);
  }
  const template = catalog.load();
  if (template.template_id !== templateId)
    throw new Error('[CUSTOMER_DECISION_TEMPLATE_ID_MISMATCH] template id does not match its file');
  return template;
}

export interface LoadDecisionTemplateOptions {
  /**
   * The tenant whose own template of this id is used first. Read as the
   * tenant-bound ledger role. Tenant templates are read fresh on every call
   * (never cached), so no tenant's template can be served to another.
   */
  tenantSlug?: string;
}

/** The template and where it came from. */
export function resolveDecisionTemplate(
  templateId: string,
  opts: LoadDecisionTemplateOptions = {}
): { template: DecisionTemplate; origin: DecisionTemplateOrigin } {
  assertTemplateId(templateId);
  if (opts.tenantSlug && !PRODUCT_ONLY_TEMPLATE_IDS.includes(templateId)) {
    const record = readTenantTemplateRecord(opts.tenantSlug, templateId);
    if (record !== undefined)
      return { template: validateDecisionTemplate(record, templateId), origin: 'tenant' };
  }
  return { template: loadProductTemplate(templateId), origin: 'product' };
}

export function loadDecisionTemplate(
  templateId: string,
  opts: LoadDecisionTemplateOptions = {}
): DecisionTemplate {
  return resolveDecisionTemplate(templateId, opts).template;
}

/** The product template ids (the product template directory's `<id>.json` files), sorted. */
export function listProductTemplateIds(): string[] {
  const dir = pathResolver.rootResolve(TEMPLATE_DIR);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => TEMPLATE_ID_PATTERN.test(id))
    .sort();
}

/** The templates a tenant can draft from: its own, then the product ones it does not shadow. */
export interface DecisionTemplateListing {
  template_id: string;
  origin: DecisionTemplateOrigin;
  shadows_product: boolean;
}

export function listDecisionTemplates(tenantSlug: string): DecisionTemplateListing[] {
  const product = new Set(listProductTemplateIds());
  const own = listTenantTemplateIds(tenantSlug).filter(
    (id) => !PRODUCT_ONLY_TEMPLATE_IDS.includes(id)
  );
  const rows: DecisionTemplateListing[] = own.map((template_id) => ({
    template_id,
    origin: 'tenant',
    shadows_product: product.has(template_id),
  }));
  for (const template_id of product) {
    if (!own.includes(template_id))
      rows.push({ template_id, origin: 'product', shadows_product: false });
  }
  return rows.sort((a, b) => a.template_id.localeCompare(b.template_id));
}

export type TemplateTextResolver = (key: string, locale: 'ja' | 'en') => string;

/** Default resolver: the repo's vocabulary helper (`t`). An unknown key is an error, never a rendered key. */
export const resolveVocabularyText: TemplateTextResolver = (key, locale) => {
  const text = t(key as VocabularyKey, undefined, locale);
  if (text === key)
    throw new Error(`[CUSTOMER_DECISION_TEMPLATE_TEXT_MISSING] no vocabulary text for ${key}`);
  return text;
};

export interface InstantiateTemplateOptions {
  agendaId: string;
  tenantSlug: string;
  caseId: string;
  customer: string;
  locale: 'ja' | 'en';
  now: string;
  title?: string;
  /** Who the request is from, as the customer sees it. */
  from?: string;
  dealId?: string;
  projectId?: string;
  resolveText?: TemplateTextResolver;
}

/**
 * Resolve one text slot in the agenda's locale: a vocabulary key through the
 * resolver, inline text by its locale. A slot with neither, or inline text
 * without that locale, is an error — never another language, never a key.
 */
function slotText(
  key: string | undefined,
  inline: LocalizedText | undefined,
  locale: 'ja' | 'en',
  resolve: TemplateTextResolver,
  slot: string
): string {
  if (key !== undefined) return resolve(key, locale);
  const text = inline?.[locale];
  if (typeof text === 'string' && text.trim()) return text;
  throw new Error(
    `[CUSTOMER_DECISION_TEMPLATE_LOCALE_MISSING] template text ${slot} has no ${locale} text`
  );
}

function objectiveText(
  objective: DecisionTemplateObjective,
  locale: 'ja' | 'en',
  resolve: TemplateTextResolver
): AgendaObjective {
  const criteria = (objective.success_criteria ?? []).map((criterion, index) =>
    typeof criterion === 'string'
      ? resolve(criterion, locale)
      : slotText(undefined, criterion, locale, resolve, `objective.success_criteria[${index}]`)
  );
  return {
    statement: slotText(
      objective.statement_key,
      objective.statement,
      locale,
      resolve,
      'objective.statement'
    ),
    ...(criteria.length > 0 ? { success_criteria: criteria } : {}),
  };
}

/** A draft agenda (revision 1) from a template; no `our_decision` yet (CD-04 fills it). */
export function instantiateTemplate(
  template: DecisionTemplate,
  opts: InstantiateTemplateOptions
): DecisionAgenda {
  if (!AGENDA_ID_PATTERN.test(opts.agendaId))
    throw new Error('[CUSTOMER_DECISION_AGENDA_ID_INVALID] invalid agenda id');
  const resolve = opts.resolveText ?? resolveVocabularyText;
  const locale = opts.locale;
  const agenda: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: opts.agendaId,
    tenant_slug: opts.tenantSlug,
    case_id: opts.caseId,
    customer: opts.customer,
    title: opts.title ?? slotText(template.title_key, template.title, locale, resolve, 'title'),
    ...(opts.from ? { from: opts.from } : {}),
    phase: template.phase,
    revision: 1,
    locale,
    ...(opts.dealId ? { deal_id: opts.dealId } : {}),
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(template.objective
      ? { objective: objectiveText(template.objective, locale, resolve) }
      : {}),
    entries: template.entries.map((entry) => {
      const at = (slot: string) => `entries.${entry.entry_id}.${slot}`;
      return {
        entry_id: entry.entry_id,
        item: entry.item,
        key: entry.key,
        kind: entry.kind,
        question: slotText(entry.question_key, entry.question, locale, resolve, at('question')),
        background: slotText(
          entry.background_key,
          entry.background,
          locale,
          resolve,
          at('background')
        ),
        ...(entry.options
          ? {
              options: entry.options.map((option, index) => {
                const optionAt = (slot: string) => at(`options[${index}].${slot}`);
                const impactText = (part: 'cost' | 'schedule' | 'scope') =>
                  slotText(
                    option.impact_keys?.[part],
                    option.impact?.[part],
                    locale,
                    resolve,
                    optionAt(`impact.${part}`)
                  );
                const impact: AgendaOptionImpact = {
                  cost: impactText('cost'),
                  schedule: impactText('schedule'),
                  scope: impactText('scope'),
                };
                return {
                  value: option.value,
                  label: slotText(
                    option.label_key,
                    option.label,
                    locale,
                    resolve,
                    optionAt('label')
                  ),
                  impact,
                };
              }),
            }
          : {}),
        ...(entry.org_default ? { org_default: structuredClone(entry.org_default) } : {}),
        requires_customer: entry.requires_customer,
      };
    }),
    status: 'draft',
    created_at: opts.now,
    updated_at: opts.now,
  };
  if (!agendaCatalog) {
    const schemaPath = pathResolver.rootResolve(AGENDA_SCHEMA);
    agendaCatalog = defineCatalog<DecisionAgenda>({
      id: 'customer-decision-template-agenda',
      path: schemaPath,
      schema: schemaPath,
    });
  }
  return agendaCatalog.validate(agenda);
}
