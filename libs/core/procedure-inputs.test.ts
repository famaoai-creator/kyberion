import { describe, expect, it } from 'vitest';
import { collectProcedureUserInputs } from './procedure-inputs.js';
import type { BrowserExtensionRecording } from './browser-extension-bridge.js';
import type { ProcedureEntry } from './procedure-types.js';

function rec(): BrowserExtensionRecording {
  return {
    schema_version: 'browser-recording.v1',
    recording_id: 'rec-1',
    source: 'chrome-extension',
    created_at: '2026-06-24T00:00:00Z',
    tab: { origin: 'https://x.example', origin_hash: 'h', title: 't' },
    extension: { version: '1.0.0' },
    actions: [
      {
        action_id: 'a1', op: 'fill_ref', summary: 'name', risk: 'low', captured_at: '2026-06-24T00:00:00Z',
        target: { ref: '@e1', role: 'textbox', name: 'Name', snapshot_hash: 'x' },
        variable: { name: 'period', classification: 'user_input' },
      },
      {
        action_id: 'a2', op: 'fill_ref', summary: 'token', risk: 'low', captured_at: '2026-06-24T00:00:00Z',
        target: { ref: '@e2', role: 'textbox', name: 'Token', snapshot_hash: 'x' },
        variable: { name: 'api_token', classification: 'secret_ref' },
      },
    ],
    risk_summary: { requires_manual_review: true, sensitive_input_omitted: 0, approval_required_count: 0 },
  };
}

const entry: ProcedureEntry = {
  procedure_id: 'p1', substrate: 'browser',
  adapter: { recorder: 'chrome-extension', executor: 'extension_session' },
  target: { name: 'X', origins: ['https://x.example'] },
  intent_phrases: ['do x'], pipeline_ref: 'p', risk_class: 'low', version: '1.0.0', status: 'active',
};

describe('collectProcedureUserInputs', () => {
  it('returns user_input variables and excludes secret_ref', () => {
    const inputs = collectProcedureUserInputs(entry, rec());
    expect(inputs.map((i) => i.name)).toEqual(['period']);
  });

  it('enriches with declared required_inputs metadata', () => {
    const withMeta: ProcedureEntry = {
      ...entry,
      required_inputs: [{ name: 'period', label: '対象期間', type: 'date', optional: true }],
    };
    const inputs = collectProcedureUserInputs(withMeta, rec());
    expect(inputs[0]).toEqual({ name: 'period', label: '対象期間', type: 'date', optional: true });
  });

  it('defaults label/type when no metadata is declared', () => {
    const inputs = collectProcedureUserInputs(entry, rec());
    expect(inputs[0]).toEqual({ name: 'period', label: 'period', type: 'string', optional: false });
  });
});
