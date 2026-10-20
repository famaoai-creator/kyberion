import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  reserveExternalOperation,
  externalOperationReservationRelativePath,
} from './external-operation-store.js';

describe('durable external execution reservation', () => {
  it('uses distinct production tenant/invocation paths and never stores tenant data in system', () => {
    const input = {
      tenantSlug: 'acme',
      operationId: 'service:send',
      invocationId: 'one',
      effectHash: 'abc',
    };
    const file = externalOperationReservationRelativePath(input, {});
    expect(file).toMatch(
      /^active\/shared\/runtime\/external-operations\/confidential\/acme\/[a-f0-9]{64}\.json$/
    );
    expect(
      externalOperationReservationRelativePath({ ...input, tenantSlug: 'other' }, {})
    ).not.toBe(file);
    expect(
      externalOperationReservationRelativePath({ ...input, invocationId: 'two' }, {})
    ).not.toBe(file);
    expect(externalOperationReservationRelativePath({ ...input, effectHash: 'changed' }, {})).toBe(
      file
    );
    expect(
      externalOperationReservationRelativePath({ ...input, tenantSlug: undefined }, {})
    ).toContain('/personal/shared/');
  });
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  beforeAll(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('blocks concurrent and subsequent attempts after the first durable start', async () => {
    const input = {
      tenantSlug: 'acme',
      operationId: 'service:send',
      invocationId: randomUUID(),
      effectHash: 'abc',
    };
    let release!: () => void;
    const delayedEffect = new Promise<void>((resolve) => {
      release = resolve;
    });
    reserveExternalOperation(input);
    const first = delayedEffect.then(() => 'completed');
    expect(() => reserveExternalOperation(input)).toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    release();
    expect(await first).toBe('completed');
    expect(() => reserveExternalOperation(input)).toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(() => reserveExternalOperation({ ...input, effectHash: 'changed' })).toThrow(
      'EXTERNAL_EXECUTION_ALREADY_RESERVED'
    );
  });

  it('survives module reload and partitions tenant and invocation identities', async () => {
    const input = {
      tenantSlug: 'acme',
      operationId: 'service:send',
      invocationId: randomUUID(),
      effectHash: 'abc',
    };
    reserveExternalOperation(input);
    vi.resetModules();
    const reloaded = await import('./external-operation-store.js');
    expect(() => reloaded.reserveExternalOperation(input)).toThrow(
      'EXTERNAL_EXECUTION_ALREADY_RESERVED'
    );
    expect(() =>
      reloaded.reserveExternalOperation({ ...input, tenantSlug: 'other' })
    ).not.toThrow();
    expect(() =>
      reloaded.reserveExternalOperation({ ...input, invocationId: randomUUID() })
    ).not.toThrow();
  });
});
