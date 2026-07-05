import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { guardRequest, requireChronosAccess, roleToMissionRole } from '../../../lib/api-guard';
import { compileUserIntentFlow } from '@agent/core/intent-contract';
import { loadOrganizationProfile } from '@agent/core';
import { buildPlanPreview } from '../../../lib/plan-preview';

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAccess = requireChronosAccess(req, 'readonly');
    if (requiresAccess) return requiresAccess;

    const body = await req.json();
    const requestText = typeof body?.requestText === 'string' ? body.requestText.trim() : '';
    if (!requestText) {
      return NextResponse.json({ error: 'Missing requestText' }, { status: 400 });
    }

    const tier =
      body?.tier === 'personal' || body?.tier === 'public' || body?.tier === 'confidential'
        ? body.tier
        : 'confidential';
    process.env.MISSION_ROLE = roleToMissionRole('localadmin');
    const missionId =
      typeof body?.missionId === 'string'
        ? body.missionId.trim()
        : `PREVIEW-${randomUUID().slice(0, 8).toUpperCase()}`;
    const flow = await compileUserIntentFlow({
      text: requestText,
      channel: 'chronos',
      locale: typeof body?.locale === 'string' ? body.locale : 'ja',
      projectId: typeof body?.projectId === 'string' ? body.projectId : undefined,
      projectName: typeof body?.projectName === 'string' ? body.projectName : undefined,
      trackId: typeof body?.trackId === 'string' ? body.trackId : undefined,
      trackName: typeof body?.trackName === 'string' ? body.trackName : undefined,
      tier,
      tenantId: typeof body?.tenantId === 'string' ? body.tenantId : undefined,
      tenantSlug: typeof body?.tenantSlug === 'string' ? body.tenantSlug : undefined,
      serviceBindings: Array.isArray(body?.serviceBindings)
        ? body.serviceBindings.filter(
            (value: unknown): value is string => typeof value === 'string'
          )
        : undefined,
      runtimeContext:
        typeof body?.runtimeContext === 'object' && body.runtimeContext
          ? body.runtimeContext
          : undefined,
    });

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
    return NextResponse.json(
      { error: err.message || 'Failed to build plan preview' },
      { status: 500 }
    );
  }
}
