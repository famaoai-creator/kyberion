import * as path from 'node:path';
import { safeLstat, safeReadFile, safeReaddir } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import {
  registerScheduledPipeline,
  type PipelineSchedulerOptions,
  type ScheduledPipeline,
} from './src/pipeline-scheduler.js';
import { validateChronosDeliveryTarget } from './chronos-delivery.js';
import type { PipelineAdf, PipelineSchedule } from './pipeline-contract.js';

export type AutomationBlueprintSlotType = 'number' | 'text' | 'choice';

export interface AutomationBlueprintSlot {
  id: string;
  label: string;
  prompt: string;
  type: AutomationBlueprintSlotType;
  required: boolean;
  default_value?: string | number;
  min?: number;
  max?: number;
  choices?: string[];
}

export interface AutomationBlueprint {
  blueprint_id: string;
  name: string;
  pipeline_ref: string;
  cron_template: string;
  timezone?: string;
  slots: AutomationBlueprintSlot[];
  delivery?: {
    surface: string;
    channel_slot?: string;
    fixed_channel?: string;
    thread_ts?: string;
    template?: string;
  };
}

export interface ResolvedAutomationBlueprint {
  pipeline_ref: string;
  schedule: PipelineSchedule;
  values: Record<string, string | number>;
}

export interface AutomationQuestionSeed {
  blueprint_id: string;
  intro: string;
  questions: Array<{
    slot_id: string;
    prompt: string;
    required: boolean;
    default_value?: string | number;
    choices?: string[];
  }>;
}

export interface AutomationSlashCommandMetadata {
  command: string;
  description: string;
  options: Array<{
    name: string;
    description: string;
    required: boolean;
    type: AutomationBlueprintSlotType;
    choices?: string[];
  }>;
}

export interface AutomationFormSchema {
  type: 'form';
  form_id: string;
  title: string;
  fields: Array<{
    id: string;
    label: string;
    type: AutomationBlueprintSlotType;
    required: boolean;
    default_value?: string | number;
    min?: number;
    max?: number;
    choices?: string[];
  }>;
}

export interface AutomationSlashRequest {
  blueprint_id: string;
  values: Record<string, string>;
  open_form: boolean;
}

export interface AutomationBlueprintRegistration {
  resolved: ResolvedAutomationBlueprint;
  scheduled: ScheduledPipeline;
}

export interface AutomationBlueprintCatalogEntry {
  blueprint: AutomationBlueprint;
  pipeline: PipelineAdf;
}

const CRON_FIELD_NAMES = ['minute', 'hour', 'day_of_month', 'month', 'day_of_week'] as const;
const CRON_FIELD_LABELS: Record<(typeof CRON_FIELD_NAMES)[number], string> = {
  minute: '分',
  hour: '時',
  day_of_month: '日',
  month: '月',
  day_of_week: '曜日',
};
const CRON_FIELD_RANGES: Record<(typeof CRON_FIELD_NAMES)[number], [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  day_of_month: [1, 31],
  month: [1, 12],
  day_of_week: [0, 6],
};

function normalizeId(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-');
  if (!normalized || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid automation blueprint id: ${value}`);
  }
  return normalized;
}

function cronFields(cron: string): string[] {
  const fields = String(cron || '')
    .trim()
    .split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*/?,\-]+$/u.test(field))) {
    throw new Error(
      '[POLICY_VIOLATION] Automation Blueprint requires a valid five-field cron expression.'
    );
  }
  return fields;
}

function numericSlot(
  id: (typeof CRON_FIELD_NAMES)[number],
  value: string
): AutomationBlueprintSlot | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const [min, max] = CRON_FIELD_RANGES[id];
  const numeric = Number(value);
  if (numeric < min || numeric > max) {
    throw new Error(
      `[POLICY_VIOLATION] Cron ${id} value must be between ${min} and ${max}: ${numeric}`
    );
  }
  return {
    id,
    label: CRON_FIELD_LABELS[id],
    prompt: `${CRON_FIELD_LABELS[id]}を指定してください`,
    type: 'number',
    required: true,
    default_value: numeric,
    min,
    max,
  };
}

function deliverySlot(schedule: PipelineSchedule): AutomationBlueprint['delivery'] {
  const target = schedule.deliver_to;
  if (!target) return undefined;
  const channelSlot = 'delivery_channel';
  return {
    surface: target.surface,
    channel_slot: channelSlot,
    fixed_channel: target.channel,
    ...(target.thread_ts ? { thread_ts: target.thread_ts } : {}),
    ...(target.template ? { template: target.template } : {}),
  };
}

/** Extract one shared slot schema from an existing scheduled pipeline. */
export function createAutomationBlueprintFromPipeline(
  pipelineRef: string,
  pipeline: Pick<PipelineAdf, 'name' | 'schedule'>
): AutomationBlueprint {
  if (!pipeline.schedule?.cron) throw new Error('Pipeline does not declare a schedule.cron.');
  const ref = String(pipelineRef || '').trim();
  if (!ref.startsWith('pipelines/') || ref.includes('..')) {
    throw new Error(
      `[POLICY_VIOLATION] Automation Blueprint pipeline ref must stay under pipelines/: ${ref}`
    );
  }
  const fields = cronFields(pipeline.schedule.cron);
  const slots: AutomationBlueprintSlot[] = [];
  const cronTemplate = fields
    .map((field, index) => {
      const id = CRON_FIELD_NAMES[index];
      const slot = numericSlot(id, field);
      if (slot) {
        slots.push(slot);
        return `{{${id}}}`;
      }
      return field;
    })
    .join(' ');
  const delivery = deliverySlot(pipeline.schedule);
  if (delivery) {
    slots.push({
      id: delivery.channel_slot!,
      label: '配信先 channel',
      prompt: '結果を届ける channel を指定してください',
      type: 'text',
      required: true,
      default_value: delivery.fixed_channel,
    });
  }
  const blueprintId = normalizeId(pipeline.schedule.id || pipeline.name || ref);
  return {
    blueprint_id: blueprintId,
    name: String(pipeline.name || blueprintId),
    pipeline_ref: ref,
    cron_template: cronTemplate,
    ...(pipeline.schedule.timezone ? { timezone: pipeline.schedule.timezone } : {}),
    slots,
    ...(delivery ? { delivery } : {}),
  };
}

export function buildAutomationQuestionSeed(
  blueprint: AutomationBlueprint
): AutomationQuestionSeed {
  return {
    blueprint_id: blueprint.blueprint_id,
    intro: `${blueprint.name} の実行条件を指定してください。`,
    questions: blueprint.slots.map((slot) => ({
      slot_id: slot.id,
      prompt: slot.prompt,
      required: slot.required,
      ...(slot.default_value === undefined ? {} : { default_value: slot.default_value }),
      ...(slot.choices ? { choices: slot.choices } : {}),
    })),
  };
}

export function buildAutomationSlashCommand(
  blueprint: AutomationBlueprint
): AutomationSlashCommandMetadata {
  return {
    command: `/kyberion schedule ${blueprint.blueprint_id}`,
    description: `${blueprint.name} の schedule を slot 入力から登録します。`,
    options: blueprint.slots.map((slot) => ({
      name: slot.id,
      description: slot.prompt,
      required: slot.required,
      type: slot.type,
      ...(slot.choices ? { choices: slot.choices } : {}),
    })),
  };
}

export function buildAutomationFormSchema(blueprint: AutomationBlueprint): AutomationFormSchema {
  return {
    type: 'form',
    form_id: blueprint.blueprint_id,
    title: blueprint.name,
    fields: blueprint.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      type: slot.type,
      required: slot.required,
      ...(slot.default_value === undefined ? {} : { default_value: slot.default_value }),
      ...(slot.min === undefined ? {} : { min: slot.min }),
      ...(slot.max === undefined ? {} : { max: slot.max }),
      ...(slot.choices ? { choices: slot.choices } : {}),
    })),
  };
}

function resolveSlot(slot: AutomationBlueprintSlot, raw: unknown): string | number {
  const value = raw === undefined || raw === '' ? slot.default_value : raw;
  if (value === undefined || value === null || value === '') {
    if (slot.required) throw new Error(`[POLICY_VIOLATION] Missing automation slot: ${slot.id}`);
    return '';
  }
  if (slot.type === 'number') {
    const numeric = Number(value);
    if (
      !Number.isInteger(numeric) ||
      slot.min === undefined ||
      slot.max === undefined ||
      numeric < slot.min ||
      numeric > slot.max
    ) {
      throw new Error(`[POLICY_VIOLATION] Invalid numeric automation slot: ${slot.id}`);
    }
    return numeric;
  }
  const textValue = String(value).trim();
  if (!textValue || textValue.length > 500 || textValue.includes('\u0000')) {
    throw new Error(`[POLICY_VIOLATION] Invalid automation slot: ${slot.id}`);
  }
  if (slot.type === 'choice' && !slot.choices?.includes(textValue)) {
    throw new Error(`[POLICY_VIOLATION] Unsupported choice for automation slot: ${slot.id}`);
  }
  return textValue;
}

/** Resolve one shared slot input into the schedule consumed by Chronos. */
export function resolveAutomationBlueprint(
  blueprint: AutomationBlueprint,
  values: Record<string, unknown> = {}
): ResolvedAutomationBlueprint {
  const knownSlots = new Set(blueprint.slots.map((slot) => slot.id));
  for (const key of Object.keys(values)) {
    if (!knownSlots.has(key)) {
      throw new Error(`[POLICY_VIOLATION] Unknown automation slot value: ${key}`);
    }
  }
  const resolvedValues: Record<string, string | number> = {};
  for (const slot of blueprint.slots) {
    resolvedValues[slot.id] = resolveSlot(slot, values[slot.id]);
  }
  const cron = blueprint.cron_template.replace(
    /\{\{([a-z0-9._-]+)\}\}/gu,
    (_match, key: string) => {
      const value = resolvedValues[key];
      if (value === undefined)
        throw new Error(`[POLICY_VIOLATION] Unknown automation slot: ${key}`);
      return String(value);
    }
  );
  const schedule: PipelineSchedule = {
    id: blueprint.blueprint_id,
    cron,
    ...(blueprint.timezone ? { timezone: blueprint.timezone } : {}),
  };
  if (blueprint.delivery) {
    const channel = blueprint.delivery.channel_slot
      ? resolvedValues[blueprint.delivery.channel_slot]
      : blueprint.delivery.fixed_channel;
    if (channel === undefined || channel === '') {
      throw new Error('[POLICY_VIOLATION] Automation Blueprint delivery channel is required.');
    }
    schedule.deliver_to = {
      surface: blueprint.delivery.surface,
      channel: String(channel),
      ...(blueprint.delivery.thread_ts ? { thread_ts: blueprint.delivery.thread_ts } : {}),
      ...(blueprint.delivery.template ? { template: blueprint.delivery.template } : {}),
    };
  }
  return { pipeline_ref: blueprint.pipeline_ref, schedule, values: resolvedValues };
}

function validatePipelineRef(pipelineRef: string): string {
  const ref = String(pipelineRef || '').trim();
  if (!/^pipelines\/[A-Za-z0-9._/-]+\.json$/u.test(ref) || ref.includes('..')) {
    throw new Error(`[POLICY_VIOLATION] Automation Blueprint pipeline ref is invalid: ${ref}`);
  }
  return ref;
}

function readPipelineAdf(pipelineRef: string): PipelineAdf {
  const ref = validatePipelineRef(pipelineRef);
  const absolute = pathResolver.rootResolve(ref);
  const raw = JSON.parse(safeReadFile(absolute, { encoding: 'utf8' }) as string) as unknown;
  const pipeline = validatePipelineAdf(raw);
  const guardrails = validatePipelineGuardrails(pipeline, ref);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline;
}

function collectPipelineRefs(directory: string, prefix = 'pipelines'): string[] {
  const refs: string[] = [];
  for (const name of safeReaddir(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = `${prefix}/${name}`;
    if (safeLstat(absolute).isDirectory()) {
      refs.push(...collectPipelineRefs(absolute, relative));
    } else if (name.endsWith('.json')) {
      refs.push(relative);
    }
  }
  return refs;
}

/** Load a validated Blueprint from the governed pipeline catalog. */
export function loadAutomationBlueprint(pipelineRef: string): AutomationBlueprintCatalogEntry {
  const ref = validatePipelineRef(pipelineRef);
  const pipeline = readPipelineAdf(ref);
  return {
    blueprint: createAutomationBlueprintFromPipeline(ref, pipeline),
    pipeline,
  };
}

/** List valid schedule-backed Blueprints; malformed pipelines are excluded. */
export function listAutomationBlueprintCatalog(): AutomationBlueprintCatalogEntry[] {
  const root = pathResolver.rootResolve('pipelines');
  return collectPipelineRefs(root).flatMap((ref) => {
    try {
      return [loadAutomationBlueprint(ref)];
    } catch {
      return [];
    }
  });
}

export function findAutomationBlueprint(blueprintId: string): AutomationBlueprintCatalogEntry {
  const id = normalizeId(blueprintId);
  const matches = listAutomationBlueprintCatalog().filter(
    (entry) => entry.blueprint.blueprint_id === id
  );
  if (matches.length === 0) {
    throw new Error(`[POLICY_VIOLATION] Unknown automation Blueprint: ${blueprintId}`);
  }
  if (matches.length > 1) {
    throw new Error(`[POLICY_VIOLATION] Duplicate automation Blueprint id: ${id}`);
  }
  return matches[0];
}

/** Parse `/kyberion schedule <blueprint> [slot=value ...] [--form]`. */
export function parseAutomationSlashRequest(text: string): AutomationSlashRequest {
  const tokens = String(text || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens[0] !== 'schedule' || !tokens[1]) {
    throw new Error('Usage: /kyberion schedule <blueprint-id> [slot=value ...] [--form]');
  }
  const values: Record<string, string> = {};
  let openForm = false;
  for (const token of tokens.slice(2)) {
    if (token === '--form') {
      openForm = true;
      continue;
    }
    const match = /^(?<key>[a-z0-9][a-z0-9._-]{0,63})=(?<value>[^=]+)$/u.exec(token);
    if (!match?.groups) {
      throw new Error(`Invalid slot assignment: ${token}`);
    }
    const key = match.groups.key;
    if (Object.hasOwn(values, key)) {
      throw new Error(`Duplicate slot assignment: ${key}`);
    }
    values[key] = match.groups.value.trim();
  }
  return { blueprint_id: normalizeId(tokens[1]), values, open_form: openForm };
}

/** Register a resolved Blueprint in the Chronos registry without writing ADF. */
export function registerAutomationBlueprint(
  entry: AutomationBlueprintCatalogEntry,
  values: Record<string, unknown> = {},
  options: PipelineSchedulerOptions & { pipelinePath?: string } = {}
): AutomationBlueprintRegistration {
  const resolved = resolveAutomationBlueprint(entry.blueprint, values);
  const target = resolved.schedule.deliver_to;
  const validatedTarget = target
    ? validateChronosDeliveryTarget(target as Parameters<typeof validateChronosDeliveryTarget>[0])
    : undefined;
  const scheduled: ScheduledPipeline = {
    id: entry.blueprint.blueprint_id,
    name: entry.blueprint.name,
    pipelinePath: options.pipelinePath || pathResolver.rootResolve(entry.blueprint.pipeline_ref),
    actuator: 'run_pipeline',
    trigger: {
      type: 'cron',
      cron: resolved.schedule.cron,
      timezone: resolved.schedule.timezone,
    },
    enabled: resolved.schedule.enabled !== false,
    context: entry.pipeline.context ?? {},
    ...(validatedTarget ? { deliver_to: validatedTarget } : {}),
  };
  registerScheduledPipeline(scheduled, options);
  return { resolved, scheduled };
}
