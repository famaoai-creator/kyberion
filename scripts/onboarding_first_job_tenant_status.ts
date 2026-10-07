/** CLI-only, status-only tenant boundary for explicit first-job status/tick. */
import { isDeepStrictEqual } from 'node:util';
import {
  resolveRole,
  resolveExecutionPersona,
  resolveIdentityContext,
  withExecutionContext,
} from '@agent/core/authority';
import {
  currentExecutionScope,
  getRegisteredEnvBool,
  getRegisteredEnvText,
} from '@agent/core/foundation';
import { requireCurrentFrontDeskDiagnosticDot, type DotCharter } from '@agent/core/dot/dot-charter';
import type { DotDispatchDeps } from '@agent/core/dot/dot-dispatch';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
  parseFrontDeskExecutionBinding,
  FRONT_DESK_RECEIPT_PIPELINE,
  type FrontDeskExecutionMapping,
} from '@agent/core/surface/front-desk-execution-contract';
import { inspectFrontDeskExecution } from '@agent/core/surface/front-desk-conversation-store';

/**
 * No generic tenant reader is exported. The closure is installed only by the
 * operator's bounded CLI status/tick, never by a surface or the general supervisor.
 * It derives the one registry target from a current server mapping after
 * validating this exact durable request, then returns only void or a fixed error.
 * The existing transcript admission reader does not confer tenant-read authority.
 */
export function createFirstJobTenantStatusAssertion(
  charter: DotCharter,
  mapping: FrontDeskExecutionMapping
): NonNullable<DotDispatchDeps['assertTenant']> {
  const expectedCharter = structuredClone(charter);
  const expectedMapping = structuredClone(mapping);
  return (requestedTenant, diagnostic): void => {
    try {
      // Runtime role allowlists are deliberately unchanged. A surface cannot
      // reach this reader by importing a CLI helper, even if it may assume stores.
      const scope = currentExecutionScope();
      const identity = resolveIdentityContext();
      if (
        identity.missionId ||
        identity.authorities.some(
          (authority) => authority === 'SUDO' || authority === 'SECRET_READ'
        ) ||
        getRegisteredEnvText('SYSTEM_ROLE') ||
        getRegisteredEnvBool('KYBERION_SUDO') ||
        resolveRole() !== 'infrastructure_sentinel' ||
        resolveExecutionPersona() !== 'worker' ||
        !scope?.tenantBound ||
        !diagnostic ||
        !isDeepStrictEqual(diagnostic.charter, expectedCharter)
      )
        throw new Error('unbound');
      const current = requireCurrentFrontDeskDiagnosticDot(expectedCharter);
      const proposal = diagnostic.proposal;
      const binding = parseFrontDeskExecutionBinding(proposal.front_desk_execution);
      if (
        !binding ||
        proposal.action_id !== 'dot_delegate_work' ||
        proposal.work_shape !== 'pipeline' ||
        proposal.pipeline_ref !== FRONT_DESK_RECEIPT_PIPELINE ||
        proposal.handoff_to !== undefined
      )
        throw new Error('unbound');
      const configured = getFrontDeskExecutionMapping(binding);
      if (!configured || !isDeepStrictEqual(configured, expectedMapping))
        throw new Error('unbound');
      const viewer = configured.viewer;
      const tenant = viewer.tenantSlugs === 'all' ? undefined : viewer.tenantSlugs[0];
      const organization = viewer.organizationIds === 'all' ? undefined : viewer.organizationIds[0];
      const project = viewer.projectIds === 'all' ? undefined : viewer.projectIds[0];
      const tenantOnly = viewer.organizationIds === 'all' && viewer.projectIds === 'all';
      if (
        viewer.source !== 'loopback' ||
        viewer.role !== 'localadmin' ||
        viewer.principalId !== 'human:presence-studio-localadmin' ||
        viewer.tenantSlugs === 'all' ||
        viewer.tenantSlugs.length !== 1 ||
        viewer.tierAccess.length !== 1 ||
        viewer.tierAccess[0] !== 'public' ||
        (!tenantOnly &&
          [viewer.organizationIds, viewer.projectIds].some(
            (values) => values === 'all' || values.length !== 1
          )) ||
        !tenant ||
        requestedTenant !== tenant ||
        scope.tenantSlug !== tenant ||
        scope.organizationId !== organization ||
        current.dot_id !== configured.dotId ||
        current.scope.tenant_slug !== tenant ||
        current.scope.organization_id !== organization ||
        current.scope.project_id !== project ||
        frontDeskMappingDigest(configured) !== binding.config_digest ||
        inspectFrontDeskExecution(binding, current).ok !== true
      )
        throw new Error('unbound');
      // Read only this tenant JSON, within the new exact-file role. Do not
      // resolveTenant: that materializes protected knowledge and overlay paths.
      const operational = withExecutionContext(
        'first_job_tenant_status_reader',
        () => readTenantProfile(tenant)?.status === 'active',
        'worker',
        tenant,
        organization
      );
      if (!operational) throw new Error('inactive');
    } catch {
      // Profile/schema/parse/path errors can contain private values. Never
      // expose or log the cause, the profile, or the registry location.
      throw new Error('first_job_tenant_status_unavailable');
    }
  };
}
