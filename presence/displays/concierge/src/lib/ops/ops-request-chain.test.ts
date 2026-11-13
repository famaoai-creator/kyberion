/**
 * The operations request chain with the real gates, viewer resolution and
 * mutation guard: only the token registry read (the counted seam) and the
 * tenant budget store are replaced.
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ reads: 0, entries: [] as unknown[] }));

vi.mock('@agent/core/chronos-access-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/chronos-access-registry')>()),
  readChronosTokenRegistrations: () => {
    registry.reads += 1;
    return registry.entries;
  },
}));
vi.mock('@agent/core/organization/tenant-rate-limiter', () => ({
  consumeTenantBudget: () => ({ allowed: true }),
}));

import { requireConciergeMutationAccess } from '../api-guard';
import { guardOpsRequest, requireOpsAccess } from './ops-request-guard';
import { resolveOpsViewerForRequest } from './ops-viewer';

const TOKEN = 'ops-chain-localadmin-token';

function mutation(): NextRequest {
  return new NextRequest('https://concierge.example/api/ops/workitems', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      host: 'concierge.example',
      origin: 'https://concierge.example',
    },
  });
}

describe('operations request chain (real gates and viewer resolution)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    registry.reads = 0;
    registry.entries = [
      {
        token_hash: createHash('sha256').update(TOKEN).digest('hex'),
        role: 'localadmin',
        tenant_slugs: ['tenant-a'],
        label: 'ops-chain',
      },
    ];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the viewer of one request once across both gates, the route and the mutation gate', () => {
    const req = mutation();
    expect(guardOpsRequest(req)).toBeNull();
    // requireOpsAccess('localadmin') runs requireConciergeMutationAccess on a mutation.
    expect(requireOpsAccess(req, 'localadmin')).toBeNull();
    const resolved = resolveOpsViewerForRequest(req);
    expect(resolved.context).toMatchObject({
      role: 'localadmin',
      tenantSlugs: ['tenant-a'],
      source: 'token',
    });
    expect(requireConciergeMutationAccess(req)).toBeNull();
    expect(resolveOpsViewerForRequest(req).context).toBe(resolved.context);
    expect(registry.reads).toBe(1);
  });

  it('resolves a second request again', () => {
    expect(guardOpsRequest(mutation())).toBeNull();
    expect(guardOpsRequest(mutation())).toBeNull();
    expect(registry.reads).toBe(2);
  });

  it('answers 401 from the gate for an unknown token, resolving once', () => {
    registry.entries = [];
    const req = mutation();
    expect(guardOpsRequest(req)?.status).toBe(401);
    expect(requireOpsAccess(req, 'readonly')?.status).toBe(401);
    expect(resolveOpsViewerForRequest(req).response?.status).toBe(401);
    expect(registry.reads).toBe(1);
  });
});
