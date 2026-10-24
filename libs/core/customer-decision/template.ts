/**
 * Customer decision templates (CD-03/04): load a governed template and turn it
 * into a draft agenda. Every `*_key` is a user-facing-vocabulary key, resolved
 * to text in the agenda's locale when the template is instantiated.
 */
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { t, type VocabularyKey } from '../t.js';
import type { AgendaEntryKind, AgendaOptionImpact, DecisionAgenda } from './model.js';
import { AGENDA_ID_PATTERN } from './model.js';

export interface DecisionTemplateEntry {
  entry_id: string;
  item: string;
  key: string;
  kind: AgendaEntryKind;
  question_key: string;
  background_key: string;
  options?: Array<{
    value: unknown;
    label_key: string;
    impact_keys: { cost: string; schedule: string; scope: string };
  }>;
  org_default?: { value: unknown; source: string };
  requires_customer: boolean;
}

export interface DecisionTemplate {
  version: string;
  template_id: string;
  phase: string;
  title_key: string;
  entries: DecisionTemplateEntry[];
}

export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{0,80}$/u;
const TEMPLATE_DIR = 'knowledge/product/orchestration/customer-decision-templates';
const TEMPLATE_SCHEMA = 'knowledge/product/schemas/customer-decision-template.schema.json';
const AGENDA_SCHEMA = 'knowledge/product/schemas/customer-decision-agenda.schema.json';

const templateCatalogs = new Map<string, GovernedCatalog<DecisionTemplate>>();
let agendaCatalog: GovernedCatalog<DecisionAgenda> | undefined;

export function loadDecisionTemplate(templateId: string): DecisionTemplate {
  if (typeof templateId !== 'string' || !TEMPLATE_ID_PATTERN.test(templateId))
    throw new Error('[CUSTOMER_DECISION_TEMPLATE_ID_INVALID] invalid template id');
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
  dealId?: string;
  projectId?: string;
  resolveText?: TemplateTextResolver;
}

/** A draft agenda (revision 1) from a template; no `our_decision` yet (CD-04 fills it). */
export function instantiateTemplate(
  template: DecisionTemplate,
  opts: InstantiateTemplateOptions
): DecisionAgenda {
  if (!AGENDA_ID_PATTERN.test(opts.agendaId))
    throw new Error('[CUSTOMER_DECISION_AGENDA_ID_INVALID] invalid agenda id');
  const text = opts.resolveText ?? resolveVocabularyText;
  const locale = opts.locale;
  const agenda: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: opts.agendaId,
    tenant_slug: opts.tenantSlug,
    case_id: opts.caseId,
    customer: opts.customer,
    title: opts.title ?? text(template.title_key, locale),
    phase: template.phase,
    revision: 1,
    locale,
    ...(opts.dealId ? { deal_id: opts.dealId } : {}),
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    entries: template.entries.map((entry) => ({
      entry_id: entry.entry_id,
      item: entry.item,
      key: entry.key,
      kind: entry.kind,
      question: text(entry.question_key, locale),
      background: text(entry.background_key, locale),
      ...(entry.options
        ? {
            options: entry.options.map((option) => {
              const impact: AgendaOptionImpact = {
                cost: text(option.impact_keys.cost, locale),
                schedule: text(option.impact_keys.schedule, locale),
                scope: text(option.impact_keys.scope, locale),
              };
              return { value: option.value, label: text(option.label_key, locale), impact };
            }),
          }
        : {}),
      ...(entry.org_default ? { org_default: structuredClone(entry.org_default) } : {}),
      requires_customer: entry.requires_customer,
    })),
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
