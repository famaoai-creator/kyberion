import { NextRequest, NextResponse } from 'next/server';
import { guardRequest } from '../../../lib/api-guard';
import * as customerResolver from '@agent/core/customer-resolver';
import { readJson as readFoundationJson } from '@agent/core/foundation';
import {
  parsePersonalAgentIdentitySummary,
  parsePersonalSovereignIdentitySummary,
} from '@agent/core/personal-identity-reader';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export const runtime = 'nodejs';

function readJson<T>(fileName: string): T | null {
  try {
    const full = assertSafeRepositoryPath(customerResolver.resolveOverlay(fileName), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(full) || !safeLstat(full).isFile()) return null;
    return readFoundationJson<T>(full);
  } catch {
    return null;
  }
}

function readText(fileName: string): string | null {
  try {
    const full = assertSafeRepositoryPath(customerResolver.resolveOverlay(fileName), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(full) || !safeLstat(full).isFile()) return null;
    return safeReadFile(full, { encoding: 'utf8' }) as string;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  return withViewerExecutionContext(resolvedViewer.context, () => {
    // ONB-03 Task 5: prefer the active customer overlay (KYBERION_CUSTOMER)
    // over knowledge/personal/, matching operator-identity.ts's resolution
    // order, so vital-check and FirstRunBanner don't misreport identity as
    // missing under a tenant overlay.
    const sovereignRaw = readJson<unknown>('my-identity.json');
    const agentRaw = readJson<unknown>('agent-identity.json');
    const sovereign = sovereignRaw ? parsePersonalSovereignIdentitySummary(sovereignRaw) : null;
    const agent = agentRaw ? parsePersonalAgentIdentitySummary(agentRaw) : null;
    const visionRaw = readText('my-vision.md');
    const vision = visionRaw
      ? visionRaw
          .replace(/^#[^\n]*\n+/, '')
          .trim()
          .slice(0, 600)
      : null;

    return NextResponse.json({
      status: 'ok',
      onboarded: Boolean(sovereign && agent),
      sovereign: sovereign
        ? {
            name: sovereign.name || null,
            language: sovereign.language || null,
            interaction_style: sovereign.interaction_style || null,
            primary_domain: sovereign.primary_domain || null,
            status: sovereign.status || null,
          }
        : null,
      agent: agent
        ? {
            agent_id: agent.agent_id || null,
            role: agent.role || null,
            owner: agent.owner || null,
            trust_tier: agent.trust_tier || null,
          }
        : null,
      vision,
    });
  });
}
