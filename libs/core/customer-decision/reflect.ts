/**
 * Reflecting customer decisions (CD-08): project an agenda's effective
 * decisions into the input of the MO-11 alignment brief, and phrase a
 * deal-note summary for decision switches. Pure functions plus a small
 * secure-io store for `<case dir>/brief-input.json`.
 */
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { t } from '../t.js';
import { agendaContentHash } from './hash.js';
import type {
  DecisionAgenda,
  DecisionLayerName,
  DecisionSwitch,
  EffectiveDecision,
  EffectiveDecisionStatus,
} from './model.js';
import { customerDecisionPaths, type CustomerDecisionLocation } from './store.js';

export interface CustomerDecisionBriefInput {
  version: '1.0.0';
  case_id: string;
  agenda_id: string;
  content_hash: string;
  generated_at: string;
  decisions: Array<{
    entry_id: string;
    item: string;
    key: string;
    question: string;
    value?: unknown;
    status: EffectiveDecisionStatus;
    layer: DecisionLayerName | 'none';
    decision_id?: string;
  }>;
  open_items: Array<{
    entry_id: string;
    question: string;
    status: 'awaiting_customer' | 'undecided';
  }>;
}

export function projectBriefInput(
  agenda: DecisionAgenda,
  effective: readonly EffectiveDecision[],
  now: string
): CustomerDecisionBriefInput {
  const questions = new Map(agenda.entries.map((entry) => [entry.entry_id, entry.question]));
  const decisions: CustomerDecisionBriefInput['decisions'] = [];
  const openItems: CustomerDecisionBriefInput['open_items'] = [];
  for (const decision of effective) {
    const question = questions.get(decision.entry_id);
    if (question === undefined) continue;
    decisions.push({
      entry_id: decision.entry_id,
      item: decision.item,
      key: decision.key,
      question,
      ...(decision.value !== undefined ? { value: decision.value } : {}),
      status: decision.status,
      layer: decision.layer,
      ...(decision.decision_id ? { decision_id: decision.decision_id } : {}),
    });
    if (decision.status === 'awaiting_customer' || decision.status === 'undecided')
      openItems.push({ entry_id: decision.entry_id, question, status: decision.status });
  }
  return {
    version: '1.0.0',
    case_id: agenda.case_id,
    agenda_id: agenda.agenda_id,
    content_hash: agendaContentHash(agenda),
    generated_at: now,
    decisions,
    open_items: openItems,
  };
}

function displayValue(value: unknown, locale: 'ja' | 'en'): string {
  if (value === undefined) return t('customer_decision:value_not_set', undefined, locale);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The pieces of the mission brief (`mission-brief.schema.json` `scope` and `openItems`) this input feeds. */
export function briefFieldsFromDecisionInput(
  input: CustomerDecisionBriefInput,
  locale: 'ja' | 'en'
): { scope: { in: string[]; out?: string[] }; openItems: string[] } {
  const scopeIn: string[] = [];
  const openItems: string[] = [];
  for (const decision of input.decisions) {
    const params = { question: decision.question, value: displayValue(decision.value, locale) };
    if (decision.status === 'confirmed')
      scopeIn.push(t('customer_decision:brief_decision_confirmed', params, locale));
    else if (decision.status === 'provisional')
      scopeIn.push(t('customer_decision:brief_decision_provisional', params, locale));
    else if (decision.status === 'awaiting_customer')
      openItems.push(
        t('customer_decision:brief_open_awaiting', { question: decision.question }, locale)
      );
    else
      openItems.push(
        t('customer_decision:brief_open_undecided', { question: decision.question }, locale)
      );
  }
  return { scope: { in: scopeIn }, openItems };
}

const BRIEF_INPUT_FILE = 'brief-input.json';
const BRIEF_INPUT_SCHEMA = 'knowledge/product/schemas/customer-decision-brief-input.schema.json';
let briefInputCatalog: GovernedCatalog<CustomerDecisionBriefInput> | undefined;

export function validateBriefInput(value: unknown): CustomerDecisionBriefInput {
  if (!briefInputCatalog) {
    const schemaPath = pathResolver.rootResolve(BRIEF_INPUT_SCHEMA);
    briefInputCatalog = defineCatalog<CustomerDecisionBriefInput>({
      id: 'customer-decision-brief-input',
      path: schemaPath,
      schema: schemaPath,
    });
  }
  return briefInputCatalog.validate(value);
}

function briefInputPath(location: CustomerDecisionLocation): string {
  return path.join(customerDecisionPaths(location).dir, BRIEF_INPUT_FILE);
}

export function writeBriefInput(
  location: CustomerDecisionLocation,
  input: CustomerDecisionBriefInput
): CustomerDecisionBriefInput {
  const validated = validateBriefInput(input);
  if (!('dir' in location) && validated.case_id !== location.caseId)
    throw new Error('[CUSTOMER_DECISION_CASE_MISMATCH] brief input case does not match location');
  const file = assertSafeRepositoryPath(briefInputPath(location), { allowMissingLeaf: true });
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, validated);
  return validated;
}

export function readBriefInput(
  location: CustomerDecisionLocation
): CustomerDecisionBriefInput | undefined {
  const file = assertSafeRepositoryPath(briefInputPath(location), { allowMissingLeaf: true });
  const raw = readJsonIfPresent<unknown>(file) ?? undefined;
  if (raw === undefined) return undefined;
  const input = validateBriefInput(raw);
  if (!('dir' in location) && input.case_id !== location.caseId)
    throw new Error('[CUSTOMER_DECISION_CASE_MISMATCH] brief input case does not match location');
  return input;
}

/** Plain deal-note text for decision switches (one line per switch). */
export function dealNoteForSwitches(
  switches: DecisionSwitch[],
  agenda: DecisionAgenda,
  locale: 'ja' | 'en'
): string {
  const entries = new Map(agenda.entries.map((entry) => [entry.entry_id, entry]));
  const label = (entryId: string, value: unknown): string => {
    const option = entries
      .get(entryId)
      ?.options?.find((candidate) => JSON.stringify(candidate.value) === JSON.stringify(value));
    return option ? option.label : displayValue(value, locale);
  };
  return switches
    .map((change) => {
      const item = entries.get(change.entry_id)?.question ?? change.item;
      const to = label(change.entry_id, change.to.value);
      if (change.kind === 'confirmed')
        return t('customer_decision:deal_note_confirmed', { item, to }, locale);
      return t(
        'customer_decision:deal_note_value_changed',
        { item, from: label(change.entry_id, change.from.value), to },
        locale
      );
    })
    .join('\n');
}
