import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeExec, debug } = vi.hoisted(() => ({ safeExec: vi.fn(() => ''), debug: vi.fn() }));
vi.mock('@agent/core/secure-io', () => ({ safeExec }));
vi.mock('@agent/core/core', () => ({ logger: { debug } }));

import { main } from './run_with_env.js';

describe('run_with_env', () => {
  beforeEach(() => {
    safeExec.mockClear();
    debug.mockClear();
  });

  it('injects assignments unchanged and notes variable names (not values) at debug level', () => {
    main(['KYBERION_PERSONA=worker', 'SYSTEM_ROLE=surface_runtime', 'node', 'x.js']);
    expect(safeExec).toHaveBeenCalledWith('node', ['x.js'], {
      env: { KYBERION_PERSONA: 'worker', SYSTEM_ROLE: 'surface_runtime' },
    });
    expect(debug).toHaveBeenCalledTimes(1);
    const note = String(debug.mock.calls[0][0]);
    expect(note).toContain('KYBERION_PERSONA, SYSTEM_ROLE');
    expect(note).not.toContain('worker');
  });

  it('stays silent when nothing is injected', () => {
    main(['node', 'x.js']);
    expect(debug).not.toHaveBeenCalled();
  });
});
