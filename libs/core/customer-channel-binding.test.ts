import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  rootResolve: vi.fn(),
}));

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    pathResolver: { ...actual.pathResolver, rootResolve: mocks.rootResolve },
  };
});

import { pathResolver } from './path-resolver.js';
import { listCustomerChannelBindings, resolveCustomerBinding } from './customer-channel-binding.js';

describe('customer-channel-binding', () => {
  let rootDir = '';

  beforeEach(() => {
    fs.mkdirSync(pathResolver.sharedTmp(), { recursive: true });
    rootDir = fs.mkdtempSync(path.join(pathResolver.sharedTmp(), 'customer-channel-binding-'));
    mocks.rootResolve.mockImplementation((relativePath: string) =>
      path.join(rootDir, relativePath)
    );
    fs.mkdirSync(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
      JSON.stringify({
        tenant_slug: 'acme',
        display_name: 'Acme',
        status: 'active',
        assigned_role: 'owner',
      })
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('loads a valid binding including the conversation mode', () => {
    const file = path.join(rootDir, 'customer', 'acme', 'connections', 'channel-bindings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        _comment: 'fixture',
        bindings: [
          {
            surface: 'slack',
            channel_id: 'C123',
            mode: 'requirements_hearing',
            active: true,
          },
        ],
      })
    );

    expect(resolveCustomerBinding('slack', 'C123', { rootDir })).toMatchObject({
      tenantSlug: 'acme',
      binding: { mode: 'requirements_hearing' },
    });
  });

  it('ignores schema-invalid binding files', () => {
    const file = path.join(rootDir, 'customer', 'acme', 'connections', 'channel-bindings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bindings: [{ surface: 'slack' }] }));

    expect(listCustomerChannelBindings({ rootDir })).toEqual([]);
  });

  it('ignores malformed binding files', () => {
    const file = path.join(rootDir, 'customer', 'acme', 'connections', 'channel-bindings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ malformed');

    expect(listCustomerChannelBindings({ rootDir })).toEqual([]);
  });

  it('ignores a customer overlay that has no active tenant profile', () => {
    const file = path.join(
      rootDir,
      'customer',
      'unregistered',
      'connections',
      'channel-bindings.json'
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ bindings: [{ surface: 'slack', channel_id: 'UNREGISTERED' }] })
    );

    expect(listCustomerChannelBindings({ rootDir })).toEqual([]);
  });

  it('ignores a customer overlay for a suspended tenant', () => {
    fs.writeFileSync(
      path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
      JSON.stringify({
        tenant_slug: 'acme',
        display_name: 'Acme',
        status: 'suspended',
        assigned_role: 'owner',
      })
    );
    const file = path.join(rootDir, 'customer', 'acme', 'connections', 'channel-bindings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ bindings: [{ surface: 'slack', channel_id: 'SUSPENDED' }] })
    );

    expect(listCustomerChannelBindings({ rootDir })).toEqual([]);
  });

  it('ignores a symlinked registered customer overlay', () => {
    const outside = path.join(rootDir, 'active', 'shared', 'escaped-customer');
    const linked = path.join(rootDir, 'customer', 'acme');
    const file = path.join(outside, 'connections', 'channel-bindings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ bindings: [{ surface: 'slack', channel_id: 'ESCAPED' }] })
    );
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked, 'dir');

    expect(resolveCustomerBinding('slack', 'ESCAPED', { rootDir })).toBeNull();
  });
});
