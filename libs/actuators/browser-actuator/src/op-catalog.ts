import { getOpInputContract } from '@agent/core';

// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch
// switches in the pipeline helpers; check:op-registry fails on drift.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

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

function withInputSchema(op: string, kind: OpSpecKind) {
  const contract = getOpInputContract('browser', op);
  return contract
    ? { op, kind, input_schema: contract.schema, examples: contract.examples }
    : { op, kind };
}

const toSpec = withInputSchema;

export function describeOps() {
  return [
    ...BROWSER_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...BROWSER_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...BROWSER_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
    ...BROWSER_ACTUATOR_CONTROL_OPS.map((op) => toSpec(op, 'control')),
  ];
}
