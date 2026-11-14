import { describe, expect, it, vi } from 'vitest';
import { main, taskRunUsage } from './task_run.js';

describe('task:run output boundary', () => {
  it('keeps usage text within the supplied printer', async () => {
    const print = vi.fn();
    await main(['--help'], print);
    expect(print).toHaveBeenCalledWith(taskRunUsage());
  });

  it('reports missing scenario through the shared printer before failing', async () => {
    const print = vi.fn();
    await expect(main([], print)).rejects.toThrow('Missing scenario id');
    expect(print).toHaveBeenCalledWith(taskRunUsage());
  });
});
