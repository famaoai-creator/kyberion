import { NextRequest, NextResponse } from 'next/server';
import { guardRequest } from '../../../lib/api-guard';
import * as customerResolver from '@agent/core/customer-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

export const runtime = 'nodejs';

interface SovereignIdentity {
  name?: string;
  language?: string;
  interaction_style?: string;
  primary_domain?: string;
  status?: string;
}

interface AgentIdentity {
  agent_id?: string;
  role?: string;
  owner?: string;
  trust_tier?: string;
}

function readJson<T>(fileName: string): T | null {
  const full = customerResolver.resolveOverlay(fileName);
  if (!safeExistsSync(full)) return null;
  try {
    return JSON.parse(safeReadFile(full, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function readText(fileName: string): string | null {
  const full = customerResolver.resolveOverlay(fileName);
  if (!safeExistsSync(full)) return null;
  try {
    return safeReadFile(full, { encoding: 'utf8' }) as string;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  // ONB-03 Task 5: prefer the active customer overlay (KYBERION_CUSTOMER)
  // over knowledge/personal/, matching operator-identity.ts's resolution
  // order, so vital-check and FirstRunBanner don't misreport identity as
  // missing under a tenant overlay.
  const sovereign = readJson<SovereignIdentity>('my-identity.json');
  const agent = readJson<AgentIdentity>('agent-identity.json');
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
}
