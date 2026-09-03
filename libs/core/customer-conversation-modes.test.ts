import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  loadSupportGrounding,
  readDealRequirementsCapture,
  saveDealRequirementsCapture,
} from './customer-conversation-modes.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const testTenant = `tenant-capture-${process.pid}`;
const testDeal = 'DEAL-ABC';
const capturePath = pathResolver.rootResolve(
  path.join('customer', testTenant, 'deals', testDeal, 'requirements.json')
);

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(path.join('customer', testTenant)), {
    recursive: true,
    force: true,
  });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('KYBERION_PERSONA', 'knowledge_steward');
  vi.stubEnv('MISSION_ROLE', 'knowledge_steward');
});

describe('customer conversation requirements paths', () => {
  it('rejects traversal-shaped tenant and deal identifiers before reading', () => {
    expect(() => readDealRequirementsCapture('../other-tenant', 'DEAL-ABC')).toThrow(
      /DEAL_SCOPE|tenant/i
    );
    expect(() => readDealRequirementsCapture('tenant-acme', '../outside')).toThrow(
      /DEAL_SCOPE|deal/i
    );
  });

  it('rejects invalid tenant scope before loading support grounding', () => {
    expect(() => loadSupportGrounding('../other-tenant')).toThrow(/CUSTOMER_SCOPE|tenant/i);
  });

  it('round-trips a validated requirements capture and fails closed for invalid files', () => {
    const requirements = {
      functional_requirements: [],
      non_functional_requirements: [],
      constraints: [],
      assumptions: [],
      open_questions: [],
    };
    const saved = saveDealRequirementsCapture({
      tenantSlug: testTenant,
      dealId: testDeal,
      requirements,
    });
    expect(readDealRequirementsCapture(testTenant, testDeal)).toEqual(saved);

    safeWriteFile(capturePath, JSON.stringify({ ...saved, unexpected: true }), {
      encoding: 'utf8',
    });
    expect(readDealRequirementsCapture(testTenant, testDeal)).toBeNull();

    safeRmSync(capturePath, { recursive: true, force: true });
    safeMkdir(capturePath, { recursive: true });
    expect(readDealRequirementsCapture(testTenant, testDeal)).toBeNull();
  });
});
