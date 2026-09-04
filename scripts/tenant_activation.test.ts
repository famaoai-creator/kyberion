import { describe, expect, it } from 'vitest';
import { main } from './tenant_activation.js';

describe('tenant activation output boundary', () => {
  it('routes help output through the injected printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Tenant activation gate');
  });
});
