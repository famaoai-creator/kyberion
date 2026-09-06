import { getOpInputContract } from '@agent/core/op-input-contracts';
import { withCatalogInputContract } from '../../../core/actuator-sdk.js';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

import type { PipelineStepType } from '../../../core/actuator-op-registry.js';
import type { ActuatorOpDescription } from '../../../core/actuator-sdk.js';

type InputSchema = Record<string, unknown>;

const BROWSER_REF_SCHEMA: InputSchema = {
  type: 'object',
  required: ['ref'],
  properties: {
    classification: { type: 'string' },
    dom_path: { type: 'string' },
    field: { type: 'string' },
    high_risk: { type: 'boolean' },
    key: { type: 'string' },
    name: { type: 'string' },
    ref: { type: 'string' },
    role: { type: 'string' },
    secret_ref: { type: 'string' },
    state: { type: 'string' },
    text: { type: 'string' },
    timeout: { type: 'number' },
    variable: {},
  },
  additionalProperties: false,
};
const BROWSER_EMPTY_SCHEMA: InputSchema = {
  type: 'object',
  properties: { export_as: { type: 'string' } },
  additionalProperties: false,
};
const BROWSER_CONTROL_SCHEMA: InputSchema = {
  type: 'object',
  properties: {
    condition: { type: 'string' },
    else: { type: 'array' },
    max_iterations: { type: 'number' },
    pipeline: { type: 'array' },
    then: { type: 'array' },
  },
  required: ['condition'],
  additionalProperties: false,
};
const BROWSER_EXTRA_CONTRACTS: Record<string, InputSchema> = {
  distill_dom: {
    type: 'object',
    properties: { export_as: { type: 'string' }, max_elements: { type: 'number' } },
    additionalProperties: false,
  },
  console: {
    type: 'object',
    properties: { export_as: { type: 'string' }, limit: { type: 'number' } },
    additionalProperties: false,
  },
  evaluate: {
    type: 'object',
    required: ['script'],
    properties: { export_as: { type: 'string' }, script: { type: 'string' } },
    additionalProperties: false,
  },
  export_session_handoff: {
    type: 'object',
    properties: {
      browser_session_id: { type: 'string' },
      export_as: { type: 'string' },
      path: { type: 'string' },
      prefer_persistent_context: { type: 'boolean' },
      target_url: { type: 'string' },
    },
    additionalProperties: false,
  },
  network: {
    type: 'object',
    properties: { export_as: { type: 'string' }, limit: { type: 'number' } },
    additionalProperties: false,
  },
  passkey_credentials: BROWSER_EMPTY_SCHEMA,
  passkey_events: BROWSER_EMPTY_SCHEMA,
  screenshot: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      fullPage: { type: 'boolean' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  tabs: BROWSER_EMPTY_SCHEMA,
  title: BROWSER_EMPTY_SCHEMA,
  url: BROWSER_EMPTY_SCHEMA,
  llm_decide: {
    type: 'object',
    properties: { export_as: { type: 'string' }, options: { type: 'array' } },
    additionalProperties: false,
  },
  export_adf: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  export_playwright: {
    type: 'object',
    properties: {
      assertions: { type: 'array' },
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  json_query: {
    type: 'object',
    required: ['from', 'path'],
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      path: { type: 'string' },
    },
    additionalProperties: false,
  },
  regex_extract: {
    type: 'object',
    required: ['from', 'pattern'],
    properties: {
      export_as: { type: 'string' },
      from: { type: 'string' },
      pattern: { type: 'string' },
    },
    additionalProperties: false,
  },
  authenticate_passkey: BROWSER_EMPTY_SCHEMA,
  clear_passkey_credentials: BROWSER_EMPTY_SCHEMA,
  click_ref: BROWSER_REF_SCHEMA,
  delete_passkey: BROWSER_EMPTY_SCHEMA,
  extension_session: {
    type: 'object',
    properties: { recording: {}, session: {} },
    additionalProperties: false,
  },
  fill_ref: BROWSER_REF_SCHEMA,
  import_session_handoff: {
    type: 'object',
    properties: {
      export_as: { type: 'string' },
      path: { type: 'string' },
      reload_after_import: { type: 'boolean' },
      target_url: { type: 'string' },
      waitUntil: { type: 'string' },
    },
    additionalProperties: false,
  },
  list_profiles: BROWSER_EMPTY_SCHEMA,
  log: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false },
  press_ref: BROWSER_REF_SCHEMA,
  register_passkey: BROWSER_EMPTY_SCHEMA,
  set_passkey_presence: {
    type: 'object',
    required: ['enabled'],
    properties: { enabled: { type: 'boolean' } },
    additionalProperties: false,
  },
  set_passkey_user_verified: {
    type: 'object',
    required: ['is_user_verified'],
    properties: { is_user_verified: { type: 'boolean' } },
    additionalProperties: false,
  },
  wait_ref: BROWSER_REF_SCHEMA,
  close_session: BROWSER_EMPTY_SCHEMA,
  if: BROWSER_CONTROL_SCHEMA,
  pause_for_operator: {
    type: 'object',
    properties: {
      continue_file: { type: 'string' },
      message: { type: 'string' },
      poll_ms: { type: 'number' },
      timeout_ms: { type: 'number' },
    },
    additionalProperties: false,
  },
  ref: BROWSER_REF_SCHEMA,
  remove_passkey_authenticator: BROWSER_EMPTY_SCHEMA,
  select_tab: {
    type: 'object',
    required: ['tab_id'],
    properties: { tab_id: { type: 'string' } },
    additionalProperties: false,
  },
  select_tab_matching: {
    type: 'object',
    properties: { title_includes: { type: 'string' }, url_includes: { type: 'string' } },
    additionalProperties: false,
  },
  setup_passkey_authenticator: {
    type: 'object',
    properties: {
      automatic_presence: { type: 'boolean' },
      enable_ui: { type: 'boolean' },
      export_as: { type: 'string' },
      has_large_blob: { type: 'boolean' },
      has_resident_key: { type: 'boolean' },
      has_user_verification: { type: 'boolean' },
      protocol: { type: 'string' },
      replace_existing: { type: 'boolean' },
      transport: { type: 'string' },
      user_verified: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  while: BROWSER_CONTROL_SCHEMA,
};

const BROWSER_EXTRA_EXAMPLES: Record<string, Array<Record<string, unknown>>> = {
  distill_dom: [{ max_elements: 50 }],
  console: [{ limit: 20 }],
  evaluate: [{ script: 'document.title' }],
  export_session_handoff: [{ path: 'active/shared/tmp/browser-handoff.json' }],
  network: [{ limit: 20 }],
  passkey_credentials: [{}],
  passkey_events: [{}],
  screenshot: [{ path: 'active/shared/tmp/screenshot.png' }],
  tabs: [{}],
  title: [{}],
  url: [{}],
  llm_decide: [{ options: [] }],
  export_adf: [{ from: 'browser_result' }],
  export_playwright: [{ from: 'browser_result' }],
  json_query: [{ from: 'browser_result', path: '.title' }],
  regex_extract: [{ from: 'browser_result', pattern: 'title' }],
  authenticate_passkey: [{}],
  clear_passkey_credentials: [{}],
  click_ref: [{ ref: '@e1' }],
  delete_passkey: [{}],
  extension_session: [{}],
  fill_ref: [{ ref: '@e1', text: 'hello' }],
  import_session_handoff: [{ path: 'active/shared/tmp/browser-handoff.json' }],
  list_profiles: [{}],
  log: [{ message: 'completed' }],
  press_ref: [{ ref: '@e1', key: 'Enter' }],
  register_passkey: [{}],
  set_passkey_presence: [{ enabled: true }],
  set_passkey_user_verified: [{ is_user_verified: true }],
  wait_ref: [{ ref: '@e1', timeout: 5000 }],
  close_session: [{}],
  if: [{ condition: 'ready' }],
  pause_for_operator: [{ message: 'Continue when ready.' }],
  ref: [{ ref: '@e1' }],
  remove_passkey_authenticator: [{}],
  select_tab: [{ tab_id: 'tab-1' }],
  select_tab_matching: [{ title_includes: 'Docs' }],
  setup_passkey_authenticator: [{ enable_ui: false }],
  while: [{ condition: 'pending', max_iterations: 3 }],
};

export const BROWSER_ACTUATOR_CAPTURE_OPS = [
  'distill_dom',
  'console',
  'content',
  'evaluate',
  'export_session_handoff',
  'goto',
  'network',
  'passkey_credentials',
  'passkey_events',
  'query_elements',
  'extract_text_ref',
  'session_health',
  'action_trail',
  'screenshot',
  'snapshot',
  'tabs',
  'title',
  'url',
] as const;

export const BROWSER_ACTUATOR_TRANSFORM_OPS = [
  'llm_decide',
  'export_adf',
  'export_playwright',
  'export_failure_bundle',
  'json_query',
  'regex_extract',
] as const;

// Note: the apply switch also accepts 'goto' as an alias, but its canonical
// classification is capture — listing it in both pools would flip
// determineActuatorStepType to apply.
export const BROWSER_ACTUATOR_APPLY_OPS = [
  'authenticate_passkey',
  'clear_passkey_credentials',
  'click',
  'click_first_match',
  'click_ref',
  'delete_passkey',
  'extension_session',
  'fill',
  'fill_ref',
  'fill_secret_ref',
  'import_session_handoff',
  'list_profiles',
  'log',
  'press',
  'press_ref',
  'scroll',
  'scroll_ref',
  'register_passkey',
  'set_passkey_presence',
  'set_passkey_user_verified',
  'wait',
  'wait_ref',
] as const;

export const BROWSER_ACTUATOR_CONTROL_OPS = [
  'close_session',
  'if',
  'open_tab',
  'pause_for_operator',
  'ref',
  'remove_passkey_authenticator',
  'select_tab',
  'select_tab_matching',
  'setup_passkey_authenticator',
  'while',
] as const;

function withInputSchema(op: string, kind: PipelineStepType) {
  const contract = getOpInputContract('browser', op);
  const description = contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : BROWSER_EXTRA_CONTRACTS[op]
      ? {
          op,
          kind,
          input_schema: BROWSER_EXTRA_CONTRACTS[op],
          examples: BROWSER_EXTRA_EXAMPLES[op] || [{}],
        }
      : { op, kind };
  return withCatalogInputContract('browser', op, kind, description);
}

const toSpec = withInputSchema;

export function describeOps(): ActuatorOpDescription[] {
  return [
    ...BROWSER_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...BROWSER_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...BROWSER_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...BROWSER_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
