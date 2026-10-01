import { describe, expect, it } from 'vitest';
import { judgedFailureKindFields } from './browser-failure-bundle.js';

describe('judgedFailureKindFields', () => {
  it('adds no failure_kind field while no judgment provider is calibrated', async () => {
    expect(await judgedFailureKindFields('page did something odd', 'Some page')).toEqual({});
    expect(await judgedFailureKindFields('HTTP 429 Too Many Requests', undefined)).toEqual({});
  });
});
