import { describe, expect, it } from 'vitest';
import { buildDisabledSurfaceReconcileRow } from './surface_runtime.js';

describe('surface_runtime reconcile — disabled surfaces (S1)', () => {
  it('reports a skipped_disabled row with the enable hint instead of skipping silently', () => {
    const { row, migrationWarning } = buildDisabledSurfaceReconcileRow(
      { id: 'personal-pads', kind: 'ui' },
      { disabledByDefault: true, credentialsConfigured: false }
    );
    expect(row).toMatchObject({
      id: 'personal-pads',
      status: 'skipped_disabled',
      enableCommand: 'pnpm surfaces enable --surface personal-pads',
    });
    expect(String(row.hint)).toContain('pnpm surfaces enable --surface personal-pads');
    expect(migrationWarning).toBeUndefined();
  });

  it('warns once when a credentialed gateway is now disabled by default', () => {
    const { row, migrationWarning } = buildDisabledSurfaceReconcileRow(
      { id: 'slack-bridge', kind: 'gateway' },
      { disabledByDefault: true, credentialsConfigured: true }
    );
    expect(migrationWarning).toContain('slack-bridge');
    expect(migrationWarning).toContain('pnpm surfaces enable --surface slack-bridge');
    expect(row.migrationWarning).toBe(migrationWarning);
  });

  it('does not warn when the operator disabled the gateway or it has no credentials', () => {
    expect(
      buildDisabledSurfaceReconcileRow(
        { id: 'slack-bridge', kind: 'gateway' },
        { disabledByDefault: false, credentialsConfigured: true }
      ).migrationWarning
    ).toBeUndefined();
    expect(
      buildDisabledSurfaceReconcileRow(
        { id: 'telegram-bridge', kind: 'gateway' },
        { disabledByDefault: true, credentialsConfigured: false }
      ).migrationWarning
    ).toBeUndefined();
  });
});
