import { describe, expect, it } from 'vitest';
import { RETIRED_STORE_ROLE_NAMES } from './retired-store-roles.js';
import { AUTONOMY_LEARNING_GRANT_ISSUANCE_RIGHT } from './autonomy-learning-capability.js';
import { PR_PUBLICATION_GRANT_ISSUANCE_RIGHT } from './pr-publication-store-capability.js';
import { PIPELINE_JOURNAL_GRANT_ISSUANCE_RIGHT } from './pipeline-journal-capability.js';
import { CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT } from './credential-material-capability.js';
import { MEMORY_PROVENANCE_GRANT_ISSUANCE_RIGHT } from '../knowledge/memory-provenance-capability.js';
import { PERSON_CHARTER_GRANT_ISSUANCE_RIGHT } from '../governance/person-charter-runtime.js';
import { CUSTOMER_DECISION_CONSUMER_GRANT_ISSUANCE_RIGHT } from './customer-decision-consumer-capability.js';
import { safeReadFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

describe('retired store role names (G2)', () => {
  it('lists every store grant issuance right that replaced a shared core role', () => {
    expect([...RETIRED_STORE_ROLE_NAMES].sort()).toEqual(
      [
        AUTONOMY_LEARNING_GRANT_ISSUANCE_RIGHT,
        CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT,
        CUSTOMER_DECISION_CONSUMER_GRANT_ISSUANCE_RIGHT,
        MEMORY_PROVENANCE_GRANT_ISSUANCE_RIGHT,
        PERSON_CHARTER_GRANT_ISSUANCE_RIGHT,
        PIPELINE_JOURNAL_GRANT_ISSUANCE_RIGHT,
        PR_PUBLICATION_GRANT_ISSUANCE_RIGHT,
      ].sort()
    );
  });

  it('declares no policy grant for a retired name', () => {
    const policy = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/security-policy.json'), {
        encoding: 'utf8',
      }) as string
    );
    for (const name of RETIRED_STORE_ROLE_NAMES)
      expect(policy.authority_role_permissions[name], name).toBeUndefined();
  });
});
