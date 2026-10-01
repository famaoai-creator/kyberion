import { describe, expect, it } from 'vitest';
import { loadActuatorOpRegistry } from '@agent/core/actuator/actuator-op-registry';
import {
  SYSTEM_CAPTURE_OP_HANDLERS,
  SYSTEM_PROCEDURE_OP_HANDLERS,
  SYSTEM_CONTROL_OP_HANDLERS,
} from './system-pipeline-core-helpers.js';

// RS-07: op dispatch is a handler map keyed by op name. The keys must match the
// governed op registry for this actuator; handlers outside the registry are an
// explicit, reviewed list (internal probes/aliases reached via apply-side
// aliasing), so a new handler cannot silently bypass registration.
const UNREGISTERED_CAPTURE_HANDLERS = [
  'camera_capture',
  'camera_injection',
  'list_audio_input_devices',
  'list_audio_output_devices',
  'resolve_path',
  'screen_capture',
  'screen_recording',
  'test_audio_inputs',
  'test_audio_outputs',
  'test_camera_mp4_roundtrip',
  'test_camera_stream',
];

describe('system-actuator op handler maps (RS-07)', () => {
  const registry = loadActuatorOpRegistry().domains.system;

  it('capture handler keys equal the registry capture ops plus the reviewed unregistered list', () => {
    expect(Object.keys(SYSTEM_CAPTURE_OP_HANDLERS).sort()).toEqual(
      [...(registry.capture ?? []), ...UNREGISTERED_CAPTURE_HANDLERS].sort()
    );
  });

  it('procedure handler keys exactly match the apply procedure ops', () => {
    const procedureOps = ['provider_preflight', 'standard_pr_lifecycle'];
    expect(Object.keys(SYSTEM_PROCEDURE_OP_HANDLERS).sort()).toEqual(procedureOps);
    for (const op of procedureOps) {
      expect(registry.apply).toContain(op);
      expect(registry.capture).not.toContain(op);
    }
  });

  it('control handler keys equal the registry control ops', () => {
    expect(Object.keys(SYSTEM_CONTROL_OP_HANDLERS).sort()).toEqual(
      [...(registry.control ?? [])].sort()
    );
  });
});
