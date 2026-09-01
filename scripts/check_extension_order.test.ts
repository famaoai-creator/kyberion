import { describe, expect, it } from 'vitest';
import { checkExtensionOrder } from './check_extension_order.js';

describe('extension order checker', () => {
  it('validates the lifecycle document without executing on import', () => {
    expect(checkExtensionOrder()).toEqual({ runtimeEvents: 15 });
  });
});
