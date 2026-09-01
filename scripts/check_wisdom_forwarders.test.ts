import { describe, expect, it } from 'vitest';
import { checkWisdomForwarders } from './check_wisdom_forwarders.js';

describe('wisdom forwarder checker', () => {
  it('keeps canonical targets and pipeline kinds aligned', () => {
    expect(checkWisdomForwarders()).toEqual([]);
  });
});
