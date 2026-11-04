import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import {
  defaultSetupChecklistReaders,
  type SetupChecklistReaders,
} from '@agent/core/surface/setup-checklist';

/**
 * Concierge readers for `setup.checklist`. An organization's charter is a
 * confidential store the surface process reads as `sovereign_concierge`, the
 * same mediation `/api/org-readiness` uses. The tenants asked about come from
 * the viewer-filtered workspace graph, so this never widens what the viewer
 * may learn: it only answers "is a charter in force" for its own tenants.
 */
export const conciergeSetupChecklistReaders: SetupChecklistReaders = {
  ...defaultSetupChecklistReaders,
  charterInForce: (tenant, now) =>
    withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() =>
        defaultSetupChecklistReaders.charterInForce(tenant, now)
      )
    ),
};
