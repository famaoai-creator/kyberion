import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';

// The route calls guardRequest(req), which expects a NextRequest (cookies
// API etc.) that a plain Request doesn't implement. Bypass it here the same
// way operator-home/route.test.ts does, and exercise everything else (the
// customer-overlay resolution this test is actually about) for real.
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
}));

import { GET } from './route.js';

const CUSTOMER_SLUG = 'onb03-fixture';
const CUSTOMER_DIR = path.join(pathResolver.rootDir(), 'customer', CUSTOMER_SLUG);
const PERSONAL_IDENTITY = pathResolver.knowledge('personal/my-identity.json');
const PERSONAL_AGENT_IDENTITY = pathResolver.knowledge('personal/agent-identity.json');
const PERSONAL_VISION = pathResolver.knowledge('personal/my-vision.md');

function request() {
  return new Request('http://localhost/api/identity');
}

describe('identity route', () => {
  const personalIdentityExisted = safeExistsSync(PERSONAL_IDENTITY);
  const personalAgentIdentityExisted = safeExistsSync(PERSONAL_AGENT_IDENTITY);
  const personalVisionExisted = safeExistsSync(PERSONAL_VISION);
  const originalPersona = process.env.KYBERION_PERSONA;

  beforeEach(() => {
    delete process.env.KYBERION_CUSTOMER;
    // tier-guard requires an authorized persona to write under customer/ and
    // knowledge/personal/; 'sovereign' has full read/write to both.
    process.env.KYBERION_PERSONA = 'sovereign';
    safeRmSync(CUSTOMER_DIR, { recursive: true, force: true });
    if (!personalIdentityExisted) safeRmSync(PERSONAL_IDENTITY, { force: true });
    if (!personalAgentIdentityExisted) safeRmSync(PERSONAL_AGENT_IDENTITY, { force: true });
    if (!personalVisionExisted) safeRmSync(PERSONAL_VISION, { force: true });
  });

  afterEach(() => {
    delete process.env.KYBERION_CUSTOMER;
    safeRmSync(CUSTOMER_DIR, { recursive: true, force: true });
    if (!personalIdentityExisted) safeRmSync(PERSONAL_IDENTITY, { force: true });
    if (!personalAgentIdentityExisted) safeRmSync(PERSONAL_AGENT_IDENTITY, { force: true });
    if (!personalVisionExisted) safeRmSync(PERSONAL_VISION, { force: true });
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
  });

  it('reports not onboarded when neither overlay nor personal data exists', async () => {
    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(false);
    expect(payload.sovereign).toBeNull();
    expect(payload.vision).toBeNull();
  });

  it('falls back to knowledge/personal when no customer overlay is active', async () => {
    safeWriteFile(
      PERSONAL_IDENTITY,
      JSON.stringify({ name: 'Personal Op', language: 'ja', status: 'active' })
    );
    safeWriteFile(PERSONAL_AGENT_IDENTITY, JSON.stringify({ agent_id: 'agent-personal' }));
    safeWriteFile(PERSONAL_VISION, '# Vision\n\nPersonal vision text.');

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(true);
    expect(payload.sovereign.name).toBe('Personal Op');
    expect(payload.agent.agent_id).toBe('agent-personal');
    expect(payload.vision).toBe('Personal vision text.');
  });

  it('prefers the active customer overlay over knowledge/personal', async () => {
    process.env.KYBERION_CUSTOMER = CUSTOMER_SLUG;
    safeMkdir(CUSTOMER_DIR, { recursive: true });
    safeWriteFile(
      path.join(CUSTOMER_DIR, 'my-identity.json'),
      JSON.stringify({ name: 'Tenant Op', language: 'en', status: 'active' })
    );
    safeWriteFile(
      path.join(CUSTOMER_DIR, 'agent-identity.json'),
      JSON.stringify({ agent_id: 'agent-tenant' })
    );
    safeWriteFile(path.join(CUSTOMER_DIR, 'my-vision.md'), '# Vision\n\nTenant vision text.');
    // A personal-tier file also exists; the overlay must win, not this one.
    safeWriteFile(
      PERSONAL_IDENTITY,
      JSON.stringify({ name: 'Personal Op', language: 'ja', status: 'active' })
    );

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.onboarded).toBe(true);
    expect(payload.sovereign.name).toBe('Tenant Op');
    expect(payload.agent.agent_id).toBe('agent-tenant');
    expect(payload.vision).toBe('Tenant vision text.');
  });
});
