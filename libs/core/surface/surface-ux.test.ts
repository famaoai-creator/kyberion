import { describe, expect, it } from 'vitest';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import { resolveSurfaceRequiredSecrets } from './surface-ux.js';

describe('surface auth readiness', () => {
  it('keeps Basic auth readiness on the catalog Basic token suffix', () => {
    const endpoint = getServiceEndpointRecord('jira');
    expect(endpoint).toBeDefined();

    expect(resolveSurfaceRequiredSecrets('jira', 'basic', endpoint!.credential_suffixes)).toEqual([
      'JIRA_CLIENT_ID',
      'JIRA_CLIENT_SECRET',
      'JIRA_ACCESS_TOKEN',
    ]);
  });
});
