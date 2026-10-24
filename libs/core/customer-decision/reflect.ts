/**
 * Reflecting customer decisions (CD-08): project an agenda's effective
 * decisions into the input of the MO-11 alignment brief, and phrase a
 * deal-note summary for decision switches. Pure functions plus a small
 * secure-io store for `<case dir>/brief-input/<agenda_id>.json` — one brief
 * input per agenda, because a case can hold several agendas and each one
 * re-projects only its own entries.
 */
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { t } from '../t.js';
import { agendaContentHash } from './hash.js';
import {
  AGENDA_ID_PATTERN,
  CUSTOMER_DECISION_LAYOUT,
  type DecisionAgenda,
  type DecisionLayerName,
  type DecisionSwitch,
  type EffectiveDecision,
  type EffectiveDecisionStatus,
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

function briefInputPath(location: CustomerDecisionLocation, agendaId: string): string {
  if (!AGENDA_ID_PATTERN.test(agendaId))
    throw new Error('[CUSTOMER_DECISION_AGENDA_ID_INVALID] invalid agenda id');
  return path.join(
    customerDecisionPaths(location).dir,
    CUSTOMER_DECISION_LAYOUT.briefInputDir,
    `${agendaId}.json`
  );
}

export function writeBriefInput(
  location: CustomerDecisionLocation,
  input: CustomerDecisionBriefInput
): CustomerDecisionBriefInput {
  const validated = validateBriefInput(input);
  if (!('dir' in location) && validated.case_id !== location.caseId)
    throw new Error('[CUSTOMER_DECISION_CASE_MISMATCH] brief input case does not match location');
  const file = assertSafeRepositoryPath(briefInputPath(location, validated.agenda_id), {
    allowMissingLeaf: true,
  });
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, validated);
  return validated;
}

export function readBriefInput(
  location: CustomerDecisionLocation,
  agendaId: string
): CustomerDecisionBriefInput | undefined {
  const file = assertSafeRepositoryPath(briefInputPath(location, agendaId), {
    allowMissingLeaf: true,
  });
  const raw = readJsonIfPresent<unknown>(file) ?? undefined;
  if (raw === undefined) return undefined;
  const input = validateBriefInput(raw);
  if (!('dir' in location) && input.case_id !== location.caseId)
    throw new Error('[CUSTOMER_DECISION_CASE_MISMATCH] brief input case does not match location');
  if (input.agenda_id !== agendaId)
    throw new Error(
      '[CUSTOMER_DECISION_AGENDA_ID_MISMATCH] brief input agenda does not match its file'
    );
  return input;
}

/** Longest customer-written text quoted into a deal note (the note itself is capped at 2000). */
export const DEAL_NOTE_CUSTOMER_TEXT_MAX = 200;

/**
 * Customer-supplied text as it may appear in a deal note: one line, control
 * and bidi-override characters removed, whitespace collapsed, truncated.
 */
export function quoteCustomerText(text: string, max = DEAL_NOTE_CUSTOMER_TEXT_MAX): string {
  const single = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Plain deal-note text for decision switches (one line per switch). A value
 * that is one of the approved options is shown by its (approved) label; any
 * other value came from the customer (free text, a change-request comment),
 * so it is quoted through {@link quoteCustomerText} and attributed to them.
 * A `confirmed` switch whose previous side was already the customer's
 * decision is the operator's confirmation (CD-08).
 */
export function dealNoteForSwitches(
  switches: DecisionSwitch[],
  agenda: DecisionAgenda,
  locale: 'ja' | 'en'
): string {
  const entries = new Map(agenda.entries.map((entry) => [entry.entry_id, entry]));
  const label = (entryId: string, value: unknown, layer: string): string => {
    const option = entries
      .get(entryId)
      ?.options?.find((candidate) => JSON.stringify(candidate.value) === JSON.stringify(value));
    if (option) return option.label;
    const written =
      typeof value === 'string' ||
      (Boolean(value) &&
        typeof value === 'object' &&
        typeof (value as { comment?: unknown }).comment === 'string');
    if (layer !== 'customer' || !written) return displayValue(value, locale);
    return t(
      'customer_decision:deal_note_customer_text',
      { text: quoteCustomerText(displayValue(value, locale)) },
      locale
    );
  };
  return switches
    .map((change) => {
      const item = entries.get(change.entry_id)?.question ?? change.item;
      const to = label(change.entry_id, change.to.value, change.to.layer);
      if (change.kind === 'confirmed' && change.from.layer === 'customer')
        return t('customer_decision:deal_note_operator_confirmed', { item, to }, locale);
      if (change.kind === 'confirmed')
        return t('customer_decision:deal_note_confirmed', { item, to }, locale);
      return t(
        'customer_decision:deal_note_value_changed',
        { item, from: label(change.entry_id, change.from.value, change.from.layer), to },
        locale
      );
    })
    .join('\n');
}
