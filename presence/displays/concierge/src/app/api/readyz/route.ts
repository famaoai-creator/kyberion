import { NextResponse } from 'next/server';
import { evaluateRuntimeReadiness, toPublicReadinessReport } from '@agent/core/runtime-readiness';

export const dynamic = 'force-dynamic';

/**
 * Readiness probe — the companion to the `/api/healthz` liveness probe.
 * 200 when every registered runtime-readiness check passes, 503 otherwise, so
 * an orchestrator (Kubernetes readinessProbe, Docker HEALTHCHECK, a load
 * balancer) routes work only to replicas that can do governed work.
 *
 * Unauthenticated by design, like healthz, and therefore data-free: the body
 * carries check ids and booleans only (`toPublicReadinessReport`). Diagnostic
 * detail stays in-process (`evaluateRuntimeReadiness`) for authenticated
 * operator surfaces.
 */
export async function GET() {
  const report = toPublicReadinessReport(await evaluateRuntimeReadiness());
  return NextResponse.json(report, {
    status: report.ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
