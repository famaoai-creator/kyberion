import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';

// route.ts calls guardRequest(req), which needs a NextRequest (cookies API
// etc.) that a plain Request doesn't implement. Bypass it here (this test
// is about identity overlay resolution, not auth) the same way
// operator-home/route.test.ts does.
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
}));

// knowledge/personal/my-identity.json is a real, shared, non-namespaced
// fixture path that many other test files across the repo also touch
// concurrently (scripts/onboarding_reset.test.ts, tests/a2a-lifecycle.test.ts,
// etc.). Writing to it here would race with them under vitest's parallel
// file execution. Mock resolveOverlay to point at a per-test unique
// active/shared/tmp/ directory instead (safeReadFile's tier-guard rejects
// paths outside the project root, so this has to stay inside it) so this
// test is hermetic and still exercises the route's real logic (it calls
// resolveOverlay(fileName) and reads whatever path comes back).
const mockResolveOverlay = vi.fn((fileName: string) => path.join(fixtureDir(), fileName));
vi.mock('@agent/core/customer-resolver', () => ({
  resolveOverlay: (fileName: string) => mockResolveOverlay(fileName),
}));

import { GET } from './route.js';

let currentFixtureDir = '';
function fixtureDir(): string {
  return currentFixtureDir;
}

function request() {
  return new Request('http://localhost/api/identity');
}

function writeFixture(fileName: string, content: string) {
  safeWriteFile(path.join(currentFixtureDir, fileName), content);
}

describe('identity route', () => {
  beforeEach(() => {
    currentFixtureDir = pathResolver.sharedTmp(`identity-route-test-${randomUUID()}`);
    safeMkdir(currentFixtureDir, { recursive: true });
    mockResolveOverlay.mockClear();
  });

  afterEach(() => {
    safeRmSync(currentFixtureDir, { recursive: true, force: true });
  });

  it('reports not onboarded when neither overlay nor personal data exists', async () => {
    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(false);
    expect(payload.sovereign).toBeNull();
    expect(payload.vision).toBeNull();
  });

  it('resolves identity, agent identity, and vision through the overlay resolver', async () => {
    writeFixture(
      'my-identity.json',
      JSON.stringify({ name: 'Op', language: 'en', status: 'active' })
    );
    writeFixture('agent-identity.json', JSON.stringify({ agent_id: 'agent-1' }));
    writeFixture('my-vision.md', '# Vision\n\nOverlay vision text.');

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(true);
    expect(payload.sovereign.name).toBe('Op');
    expect(payload.agent.agent_id).toBe('agent-1');
    expect(payload.vision).toBe('Overlay vision text.');
    // The route must resolve each file through the customer-overlay
    // resolver (the ONB-03 fix) rather than a hardcoded personal-tier path.
    expect(mockResolveOverlay).toHaveBeenCalledWith('my-identity.json');
    expect(mockResolveOverlay).toHaveBeenCalledWith('agent-identity.json');
    expect(mockResolveOverlay).toHaveBeenCalledWith('my-vision.md');
  });

  it('reports onboarded=false when only agent identity is missing', async () => {
    writeFixture('my-identity.json', JSON.stringify({ name: 'Op', language: 'en' }));

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(false);
    expect(payload.sovereign.name).toBe('Op');
    expect(payload.agent).toBeNull();
  });
});
