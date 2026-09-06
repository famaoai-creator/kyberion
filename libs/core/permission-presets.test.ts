import { describe, expect, it } from 'vitest';
import {
  derivePermissionPreset,
  resolvePermissionPreset,
  _resetPermissionPresetRegistryCacheForTests,
} from './permission-presets.js';

describe('permission-presets (DH-11)', () => {
  it('resolves named presets from the governed registry', () => {
    const readonly = resolvePermissionPreset('readonly');
    expect(readonly).toMatchObject({
      name: 'readonly',
      derived: false,
      sandbox_mode: 'read-only',
      approval_policy: 'strict',
      capability_profile: 'explorer',
    });
    expect(readonly.sandbox.enforcement).toBe('full');
  });

  it('does not allow custom to masquerade as a named persisted preset', () => {
    expect(() => resolvePermissionPreset('custom')).toThrow('PERMISSION_PRESET_UNKNOWN');
    const custom = derivePermissionPreset({
      sandbox_mode: 'read-only',
      approval_policy: 'plan',
      capability_profile: 'planner',
    });
    expect(custom).toMatchObject({ name: 'custom', derived: true });
  });

  it('recognizes an exact independent-knob combination as its named preset', () => {
    const edit = derivePermissionPreset({
      sandbox_mode: 'workspace-write',
      approval_policy: 'strict',
      capability_profile: 'implementer',
    });
    expect(edit).toMatchObject({ name: 'edit', derived: false });
    _resetPermissionPresetRegistryCacheForTests();
  });
});
