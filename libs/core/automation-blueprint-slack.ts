import type { AutomationBlueprint, AutomationFormSchema } from './automation-blueprint.js';

export interface AutomationSlackModalMetadata {
  blueprint_id: string;
  pipeline_ref: string;
  channel: string;
  thread_ts: string;
  actor_id: string;
}

export interface AutomationSlackModal {
  type: 'modal';
  callback_id: 'kyberion_automation_submit';
  private_metadata: string;
  title: { type: 'plain_text'; text: string };
  submit: { type: 'plain_text'; text: string };
  close: { type: 'plain_text'; text: string };
  blocks: Array<Record<string, unknown>>;
}

const MAX_SLACK_TEXT = 75;

function boundedText(value: string, fallback: string): string {
  const text = String(value || fallback).trim();
  return text.slice(0, MAX_SLACK_TEXT) || fallback;
}

function blockId(slotId: string): string {
  return `automation_${slotId}`;
}

function elementForSlot(
  slot: AutomationFormSchema['fields'][number],
  initialValue?: string | number
): Record<string, unknown> {
  const initial = initialValue === undefined ? slot.default_value : initialValue;
  if (slot.type === 'choice') {
    return {
      type: 'static_select',
      action_id: 'value',
      options: (slot.choices || []).map((choice) => ({
        text: { type: 'plain_text', text: boundedText(choice, '選択肢') },
        value: choice,
      })),
      ...(initial === undefined
        ? {}
        : {
            initial_option: {
              text: { type: 'plain_text', text: boundedText(String(initial), '既定値') },
              value: String(initial),
            },
          }),
    };
  }
  return {
    type: 'plain_text_input',
    action_id: 'value',
    ...(slot.type === 'number' ? { input_type: 'number' } : {}),
    ...(initial === undefined ? {} : { initial_value: String(initial) }),
  };
}

/** Build the Slack modal from the same form schema shown to other surfaces. */
export function buildAutomationSlackModal(
  blueprint: AutomationBlueprint,
  metadata: AutomationSlackModalMetadata,
  initialValues: Record<string, string | number> = {}
): AutomationSlackModal {
  const form: AutomationFormSchema = {
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
  const privateMetadata = JSON.stringify(metadata);
  if (privateMetadata.length > 3_000) {
    throw new Error('[POLICY_VIOLATION] Slack automation modal metadata is too large.');
  }
  return {
    type: 'modal',
    callback_id: 'kyberion_automation_submit',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: boundedText(blueprint.name, 'Automation schedule') },
    submit: { type: 'plain_text', text: '登録' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${boundedText(blueprint.name, blueprint.blueprint_id)}* の実行条件を指定してください。`,
        },
      },
      ...form.fields.map((slot) => ({
        type: 'input',
        block_id: blockId(slot.id),
        label: { type: 'plain_text', text: boundedText(slot.label, slot.id) },
        optional: !slot.required,
        element: elementForSlot(slot, initialValues[slot.id]),
      })),
    ],
  };
}

export function parseAutomationSlackModalMetadata(value: string): AutomationSlackModalMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch {
    throw new Error('[POLICY_VIOLATION] Invalid Slack automation modal metadata.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[POLICY_VIOLATION] Invalid Slack automation modal metadata.');
  }
  const metadata = parsed as Partial<AutomationSlackModalMetadata>;
  for (const key of ['blueprint_id', 'pipeline_ref', 'channel', 'thread_ts', 'actor_id'] as const) {
    if (!metadata[key] || typeof metadata[key] !== 'string' || metadata[key]!.length > 500) {
      throw new Error(`[POLICY_VIOLATION] Missing Slack automation metadata: ${key}`);
    }
  }
  return metadata as AutomationSlackModalMetadata;
}

export function extractAutomationSlackFormValues(
  blueprint: AutomationBlueprint,
  state: unknown
): Record<string, string> {
  const values: Record<string, string> = {};
  const root = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  for (const slot of blueprint.slots) {
    const block = root[blockId(slot.id)];
    const blockValues =
      block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
    const raw = blockValues.value;
    const action = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const selected = action.selected_option;
    const selectedValue =
      selected && typeof selected === 'object'
        ? (selected as Record<string, unknown>).value
        : undefined;
    const value = selectedValue ?? action.value;
    if (typeof value === 'string' && value.trim()) values[slot.id] = value.trim();
  }
  return values;
}
