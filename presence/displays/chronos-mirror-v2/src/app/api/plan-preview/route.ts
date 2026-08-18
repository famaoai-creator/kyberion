import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { compileUserIntentFlow } from '@agent/core/intent-contract';
import { loadOrganizationProfile } from '@agent/core/organization-profile';
import { buildPlanPreview } from '../../../lib/plan-preview';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
  withViewerExecutionContextAsync,
} from '../../../lib/viewer-context';

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAccess = requireChronosAccess(req, 'readonly');
    if (requiresAccess) return requiresAccess;
    const resolvedViewer = resolveViewerContextForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;

    const body = await req.json();
    const requestText = typeof body?.requestText === 'string' ? body.requestText.trim() : '';
    if (!requestText) {
      return NextResponse.json({ error: 'Missing requestText' }, { status: 400 });
    }

    const tenantSlug = typeof body?.tenantSlug === 'string' ? body.tenantSlug.trim() : undefined;
    const tenantSlugs = viewerScopeTenantSlugs(resolvedViewer.context, tenantSlug);
    if (!tenantSlug && tenantSlugs !== 'all' && tenantSlugs.length !== 1) {
      throw new Error('tenant must be selected for a multi-tenant viewer');
    }
    const tier = 'confidential';
    if (body?.tenantId && resolvedViewer.context.tenantSlugs !== 'all') {
      throw new Error('tenantId must be resolved by the server for a scoped viewer');
    }
    const missionId =
      typeof body?.missionId === 'string'
        ? body.missionId.trim()
        : `PREVIEW-${randomUUID().slice(0, 8).toUpperCase()}`;
    const flow = await withViewerExecutionContextAsync(resolvedViewer.context, () =>
      compileUserIntentFlow({
        text: requestText,
        channel: 'chronos',
        locale: typeof body?.locale === 'string' ? body.locale : 'ja',
        projectId: typeof body?.projectId === 'string' ? body.projectId : undefined,
        projectName: typeof body?.projectName === 'string' ? body.projectName : undefined,
        trackId: typeof body?.trackId === 'string' ? body.trackId : undefined,
        trackName: typeof body?.trackName === 'string' ? body.trackName : undefined,
        tier,
        tenantId: typeof body?.tenantId === 'string' ? body.tenantId : undefined,
        tenantSlug: tenantSlugs === 'all' ? undefined : tenantSlugs[0],
        serviceBindings: Array.isArray(body?.serviceBindings)
          ? body.serviceBindings.filter(
              (value: unknown): value is string => typeof value === 'string'
            )
          : undefined,
        runtimeContext:
          typeof body?.runtimeContext === 'object' && body.runtimeContext
            ? body.runtimeContext
            : undefined,
      })
    );

    return NextResponse.json({
      preview: buildPlanPreview(
        {
          missionId,
          requestText,
          tier,
          missionType: typeof body?.missionType === 'string' ? body.missionType : undefined,
          projectId: typeof body?.projectId === 'string' ? body.projectId : undefined,
          projectName: typeof body?.projectName === 'string' ? body.projectName : undefined,
          trackId: typeof body?.trackId === 'string' ? body.trackId : undefined,
          trackName: typeof body?.trackName === 'string' ? body.trackName : undefined,
          assignedPersona:
            typeof body?.assignedPersona === 'string' ? body.assignedPersona : undefined,
          organizationProfile: loadOrganizationProfile() || undefined,
        },
        flow
      ),
    });
  } catch (err: any) {
    if (err?.message?.includes('viewer') || err?.message?.includes('tenant'))
      return viewerErrorResponse(err);
    return viewerErrorResponse(err, 500);
  }
}
