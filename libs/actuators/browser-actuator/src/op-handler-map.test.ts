import { describe, expect, it } from 'vitest';
import { loadActuatorOpRegistry } from '@agent/core/actuator/actuator-op-registry';
import {
  BROWSER_APPLY_OP_HANDLERS,
  BROWSER_CAPTURE_OP_HANDLERS,
  BROWSER_TRANSFORM_OP_HANDLERS,
} from './browser-pipeline-helpers.js';

// RS-07: op dispatch is a handler map keyed by op name. Keys must match the
// governed op registry; the reviewed exceptions below are pre-existing
// differences preserved by the mechanical refactor (aliases such as
// `navigate` → `goto`, and `llm_decide` dispatched from the capture map
// while registered as a transform op). `extension_session` is registered but
// has no pipeline handler (attach-existing-browser runtime capability).
const EXTRA_HANDLERS: Record<'capture' | 'transform' | 'apply', string[]> = {
  capture: ['navigate', 'llm_decide'],
  transform: [],
  apply: ['navigate', 'goto'],
};
const REGISTERED_WITHOUT_HANDLER: Record<'capture' | 'transform' | 'apply', string[]> = {
  capture: [],
  transform: ['llm_decide'],
  apply: ['extension_session'],
};

describe('browser-actuator op handler maps (RS-07)', () => {
  const registry = loadActuatorOpRegistry().domains.browser;
  const cases = [
    ['capture', BROWSER_CAPTURE_OP_HANDLERS],
    ['transform', BROWSER_TRANSFORM_OP_HANDLERS],
    ['apply', BROWSER_APPLY_OP_HANDLERS],
  ] as const;

  for (const [stepType, handlers] of cases) {
    it(`${stepType} handler keys equal the registry ${stepType} ops (with reviewed exceptions)`, () => {
      const expected = [
        ...(registry[stepType] ?? []).filter(
          (op) => !REGISTERED_WITHOUT_HANDLER[stepType].includes(op)
        ),
        ...EXTRA_HANDLERS[stepType],
      ];
      expect(Object.keys(handlers).sort()).toEqual(expected.sort());
    });
  }
});
