import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ build: vi.fn(() => []), executed: vi.fn() }));
vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: () => null,
  requireChronosAccess: () => null,
}));
vi.mock('../../../../lib/su-surface-data', () => ({ buildMissionHistoryItems: mocks.build }));
vi.mock('../../../../lib/viewer-context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../lib/viewer-context')>();
  return {
    ...original,
    resolveViewerContextForRequest: () => ({
      context: {
        role: 'readonly',
        tenantSlugs: ['acme'],
        organizationIds: ['ORG-A'],
        projectIds: ['PRJ-A'],
        source: 'test',
      },
    }),
    withViewerExecutionContext: (_: unknown, fn: () => unknown) => {
      mocks.executed();
      return fn();
    },
  };
});
import { GET } from './route';
describe('mission search hierarchy boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it('applies server-authorized dimensions even when the client omits selection', async () => {
    expect(GET(new NextRequest('http://localhost/api/missions/search')).status).toBe(200);
    expect(mocks.build).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantSlugs: ['acme'],
        organizationIds: ['ORG-A'],
        projectIds: ['PRJ-A'],
      })
    );
    expect(mocks.executed).toHaveBeenCalledOnce();
  });
  it.each(['tenant=other', 'organization_id=ORG-B', 'project_id=PRJ-B'])(
    'rejects unauthorized %s before reading history',
    (query) => {
      expect(GET(new NextRequest('http://localhost/api/missions/search?' + query)).status).toBe(
        403
      );
      expect(mocks.build).not.toHaveBeenCalled();
    }
  );
});
