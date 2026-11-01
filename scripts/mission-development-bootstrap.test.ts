import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '@agent/core/authority';
import * as gates from '@agent/core/mission/mission-development-gates';
import { verifyMissionDevelopmentPublication } from '@agent/core/mission/mission-development-proof';
import * as router from './refactor/mission-controller-router.js';
import { killSwitch } from '@agent/core/governance/kill-switch';
import { main } from './mission_controller.js';

afterEach(() => vi.restoreAllMocks());
describe('canonical development proof composition', () => {
  it('installs the actual read-only verifier before routing a machine gate command', async () => {
    const install = vi.spyOn(gates, 'installMissionDevelopmentProofVerifier');
    const route = vi.spyOn(router, 'runMissionControllerAction').mockResolvedValue(undefined);
    vi.spyOn(killSwitch, 'startMonitor').mockImplementation(() => {});
    await withExecutionContextAsync('mission_controller', () =>
      main(['gate-pass', 'MSN-DEVELOPMENT-BOOTSTRAP', 'TESTS_PASSED', '--machine-only'])
    );
    expect(install).toHaveBeenCalledWith(verifyMissionDevelopmentPublication);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ action: 'gate-pass' }));
    expect(install.mock.invocationCallOrder[0]).toBeLessThan(route.mock.invocationCallOrder[0]);
  });
});
