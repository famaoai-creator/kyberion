// Layer-3 acceptance: the provider-transport seam resolves the governed
// default (loopback), a remote-provider facade invokes a seam provider
// transparently through the transport envelope, and error codes survive the
// boundary unchanged.
import { describe, expect, it } from 'vitest';
import { coreSeamCatalog, createSeam, type Seam } from '../seam.js';
import {
  LOOPBACK_TRANSPORT_ID,
  PROVIDER_TRANSPORT_SEAM,
  ProviderTransportError,
  getProviderTransport,
  resolveProviderTransport,
} from './provider-transport.js';
import './loopback-transport.js';
import { createRemoteProviderFacade } from './remote-provider-facade.js';

interface EchoProvider {
  id?: string;
  echo(text: string): string;
  fail(): never;
}

function registerTestSeam(): { seam: Seam<EchoProvider>; key: string } {
  const key = `test-echo-${Math.random().toString(36).slice(2)}`;
  const seam = createSeam<EchoProvider>({
    key,
    multiplicity: 'named',
    catalog: coreSeamCatalog,
    owner: 'libs/core/provider/provider-transport.test.ts',
  });
  seam.register(
    'local-echo',
    {
      echo: (text: string) => `echo:${text}`,
      fail: () => {
        throw new Error('[ECHO_DOWN] provider exploded');
      },
    },
    { provenance: 'builtin', source: 'libs/core/provider/provider-transport.test.ts' }
  );
  return { seam, key };
}

describe('provider-transport seam', () => {
  it('resolves the governed default to loopback', () => {
    expect(resolveProviderTransport().id).toBe(LOOPBACK_TRANSPORT_ID);
  });

  it('throws for an unknown explicit selector', () => {
    expect(() => resolveProviderTransport('no-such-transport')).toThrow(
      /unknown transport 'no-such-transport'/
    );
  });

  it('has no remote transports in the governed default chain', () => {
    expect(getProviderTransport(LOOPBACK_TRANSPORT_ID)).toBeDefined();
    expect(resolveProviderTransport().id).toBe(LOOPBACK_TRANSPORT_ID);
  });
});

describe('loopback transport invocation', () => {
  it('invokes a named seam provider in-process and returns the result', async () => {
    const { key } = registerTestSeam();
    const result = await resolveProviderTransport().invoke({
      seam: key,
      provider: 'local-echo',
      operation: 'echo',
      args: ['hello'],
    });
    expect(result).toEqual({ ok: true, result: 'echo:hello' });
  });

  it('reports SEAM_NOT_FOUND for an unknown seam', async () => {
    const result = await resolveProviderTransport().invoke({
      seam: 'no-such-seam',
      provider: 'p',
      operation: 'op',
      args: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SEAM_NOT_FOUND');
  });

  it('reports PROVIDER_NOT_FOUND for an unknown provider id', async () => {
    const { key } = registerTestSeam();
    const result = await resolveProviderTransport().invoke({
      seam: key,
      provider: 'ghost',
      operation: 'echo',
      args: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('reports OPERATION_NOT_FOUND for a missing method', async () => {
    const { key } = registerTestSeam();
    const result = await resolveProviderTransport().invoke({
      seam: key,
      provider: 'local-echo',
      operation: 'explode',
      args: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OPERATION_NOT_FOUND');
  });

  it('preserves a tagged provider error code in the envelope', async () => {
    const { key } = registerTestSeam();
    const result = await resolveProviderTransport().invoke({
      seam: key,
      provider: 'local-echo',
      operation: 'fail',
      args: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ECHO_DOWN');
      expect(result.error.message).toContain('[ECHO_DOWN] provider exploded');
    }
  });
});

describe('createRemoteProviderFacade', () => {
  it('calls the provider through the transport like an in-process object', async () => {
    const { key } = registerTestSeam();
    const facade = createRemoteProviderFacade<EchoProvider>({
      seam: key,
      provider: 'local-echo',
      operations: ['echo', 'fail'],
    });
    expect(facade.id).toBe('local-echo');
    await expect(facade.echo('via-facade')).resolves.toBe('echo:via-facade');
  });

  it('throws ProviderTransportError with the remote code on failure', async () => {
    const { key } = registerTestSeam();
    const facade = createRemoteProviderFacade<EchoProvider>({
      seam: key,
      provider: 'local-echo',
      operations: ['fail'],
    });
    await expect(facade.fail()).rejects.toMatchObject({
      name: 'ProviderTransportError',
      code: 'ECHO_DOWN',
    });
    await expect(facade.fail()).rejects.toBeInstanceOf(ProviderTransportError);
  });
});
