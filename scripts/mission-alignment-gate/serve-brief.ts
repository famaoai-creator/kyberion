/**
 * serve-brief.ts — MO-11 AG-02: the mission-brief approval surface.
 *
 * Serves a mission's alignment brief on 127.0.0.1 with the report-review layer
 * (✏️/💬/🎤) plus a decision bar, and writes the Sovereign's verdict into the
 * SAME approval record every other surface uses.
 *
 *   KYBERION_PERSONA=<p> node_modules/.bin/tsx \
 *     scripts/mission-alignment-gate/serve-brief.ts --mission <ID> [--port 8137]
 *
 * What this is NOT: a second approval channel. The decision goes through
 * applySurfaceApprovalDecision exactly as the concierge, Slack and terminal
 * surfaces do — this file only renders the request and forwards the verdict.
 * If it stopped existing, the alignment gate would still work everywhere else.
 *
 * Authentication is recorded honestly: the surface is `brief`, whose default
 * authMethod is `local_token` (MO-11 S-3). A per-launch token bound to loopback
 * proves possession, not identity, and the audit trail says so rather than
 * claiming `surface_session`.
 */
import http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { applySurfaceApprovalDecision } from '@agent/core/surface/surface-approval-ui';
import { isSeparationOfDutiesEnabled } from '@agent/core/governance/approval-store';
import {
  CLI_OPERATOR_PROVISION_COMMAND,
  detectCliAgentPrincipal,
  resolveCliOperatorIdentity,
} from '@agent/core/governance/cli-operator-principal';
import { findMissionPath } from '@agent/core/path-resolver';
import {
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { normalizeRejectionReasonCategory } from '@agent/core/rejection-reason';
import { t as catalogT } from '@agent/core/t';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { parseSafeJsonObjectInput } from '../lib/json-input.js';

import { loadMissionBriefAtPath } from './mission-brief.js';
import type { MissionBrief } from './mission-brief.js';
import { renderMissionBriefHtml } from './render-brief.js';
import { resolvePadLocale } from '../lib/pad-ui.js';
import type { SupportedLocale } from '@agent/core/locale-normalize';

const ALIGNMENT_CHANNEL = 'brief';
const MAX_BODY_BYTES = 256 * 1024;
type Print = (value: unknown) => void;

function argValue(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseDecisionRequestBody(raw: string): Record<string, unknown> {
  return parseSafeJsonObjectInput(raw, 'decision request') ?? {};
}

/**
 * Who decided, resolved server-side. The page token proves possession of the
 * loopback page, not identity, so the decider is the operator this process
 * runs as — the same local owner principal (`user:<member_id>`, else the
 * onboarding display name) that `pnpm kyberion approvals --approve` records
 * (`resolveCliOperatorIdentity()`) — never the page's `decidedBy`. A name
 * typed on the page is kept only as a note for the audit trail.
 *
 * Same rules as the terminal (`scripts/lib/approval-cli-decision.ts`): with
 * separation of duties on, approvals are refused when this server runs in an
 * agent session or has no owner member (the page token proves possession
 * only; the strong path is Chronos or presence-studio). With it off, a server
 * started in an agent session records its decisions as `caller_supplied`
 * with the agent principal, so they can never pass a later re-check.
 * Agent-session markers are advisory environment variables (best effort).
 */
export function resolveBriefDecider(
  body: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): {
  decidedBy: string;
  pageName?: string;
  refusal?: string;
  deciderIdentitySource?: 'caller_supplied';
  decidedInAgentSession?: string;
} {
  const identity = resolveCliOperatorIdentity();
  const agent = detectCliAgentPrincipal(env);
  const decidedBy = identity.principalId ?? identity.displayName;
  const typed = typeof body?.decidedBy === 'string' ? body.decidedBy.trim().slice(0, 200) : '';
  let refusal: string | undefined;
  if (body?.decision === 'approved' && (agent || !identity.principalId)) {
    try {
      if (isSeparationOfDutiesEnabled()) {
        refusal = agent
          ? `separation of duties is on and this brief server runs inside an agent session (${agent}); approve on an authenticated surface (Chronos or presence-studio), or serve the brief from your own terminal`
          : `separation of duties is on and this machine has no stable operator identity; run \`${CLI_OPERATOR_PROVISION_COMMAND}\` and reload`;
      }
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    decidedBy,
    ...(typed && typed !== decidedBy && typed !== identity.displayName ? { pageName: typed } : {}),
    ...(refusal ? { refusal } : {}),
    ...(agent
      ? { deciderIdentitySource: 'caller_supplied' as const, decidedInAgentSession: agent }
      : {}),
  };
}

async function main(args: string[] = [], print: Print = () => undefined): Promise<void> {
  const missionId = (argValue('--mission', args) || argValue('-m', args) || '')
    .trim()
    .toUpperCase();
  const port = Number(argValue('--port', args) || 8137);
  if (!missionId) {
    throw new ScriptExitError(1, 'usage: serve-brief --mission <MISSION_ID> [--port 8137]');
  }

  const missionDir = findMissionPath(missionId);
  if (!missionDir) {
    throw new ScriptExitError(1, `mission directory for ${missionId} not found`);
  }
  const briefPath = assertSafeRepositoryPath(
    path.join(missionDir, 'evidence', 'mission-brief.json'),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(briefPath)) {
    throw new ScriptExitError(1, `alignment brief not found: ${briefPath}`);
  }
  if (!safeLstat(briefPath).isFile()) {
    throw new ScriptExitError(1, `alignment brief is not a regular file: ${briefPath}`);
  }

  const TOKEN = randomBytes(16).toString('hex');

  function readBrief(): MissionBrief {
    if (!safeLstat(briefPath).isFile()) {
      throw new Error(`alignment brief is not a regular file: ${briefPath}`);
    }
    return loadMissionBriefAtPath(briefPath);
  }

  /**
   * The mission's alignment approval. Re-read on every request so the page always
   * reflects the store — including a decision just made on another surface.
   */
  function currentApproval(): ApprovalRequestRecord | undefined {
    return listApprovalRequests({
      storageChannels: [ALIGNMENT_CHANNEL],
      kind: 'mission_gate',
    }).find(
      (record) =>
        record.source?.missionId?.toUpperCase() === missionId &&
        record.correlationId === `mission-alignment-${missionId}`
    );
  }

  function renderPage(locale: SupportedLocale): string {
    const approval = currentApproval();
    return renderMissionBriefHtml(readBrief(), {
      locale,
      ...(approval
        ? {
            approval: {
              requestId: approval.id,
              status: approval.status,
              ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
              ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
              ...(approval.decidedAuthMethod
                ? { decidedAuthMethod: approval.decidedAuthMethod }
                : {}),
              endpoint: '/decision',
              token: TOKEN,
            },
          }
        : {}),
    });
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('request body too large'));
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  function json(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  async function handleDecision(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.headers['x-rv-token'] !== TOKEN)
      return json(res, 403, { ok: false, error: 'bad token' });
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(origin)) {
      return json(res, 403, { ok: false, error: 'bad origin' });
    }

    let body: Record<string, unknown>;
    try {
      body = parseDecisionRequestBody((await readBody(req)) || '{}');
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error: 'decision request must be valid JSON',
      });
    }
    const decision =
      body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
    if (!decision)
      return json(res, 400, { ok: false, error: 'decision must be approved|rejected' });
    // The decider is resolved server-side; the page's name is only a note.
    const decider = resolveBriefDecider(body);
    const { decidedBy, pageName, refusal } = decider;
    if (refusal) return json(res, 403, { ok: false, error: refusal });
    const pageNote = pageName ? `name entered on the brief page: ${pageName}` : '';
    const bodyNote = typeof body?.note === 'string' ? body.note.trim() : '';
    const note = [bodyNote, pageNote].filter(Boolean).join(' | ');

    // Never trust the page's idea of which request it is deciding: resolve the
    // mission's current approval server-side and require the two to agree.
    const approval = currentApproval();
    if (!approval)
      return json(res, 404, { ok: false, error: 'no mission_gate approval for mission' });
    if (body?.requestId && body.requestId !== approval.id) {
      return json(res, 409, {
        ok: false,
        error: 'the page is bound to a stale approval request; reload',
      });
    }
    if (approval.status !== 'pending') {
      return json(res, 409, {
        ok: false,
        error: `already ${approval.status} (decided by ${approval.decidedBy ?? '?'}); reload`,
      });
    }

    const reasonCategory =
      decision === 'rejected' ? normalizeRejectionReasonCategory(body?.reasonCategory) : undefined;
    if (decision === 'rejected' && !reasonCategory) {
      return json(res, 400, { ok: false, error: 'rejected requires a valid reasonCategory' });
    }

    try {
      const updated = applySurfaceApprovalDecision({
        surface: 'brief',
        requestId: approval.id,
        decision,
        channel: approval.channel,
        threadTs: approval.threadTs,
        decidedBy,
        ...(decider.deciderIdentitySource
          ? { deciderIdentitySource: decider.deciderIdentitySource }
          : {}),
        ...(decider.decidedInAgentSession
          ? { decidedInAgentSession: decider.decidedInAgentSession }
          : {}),
        storageChannel: ALIGNMENT_CHANNEL,
        ...(note ? { note } : {}),
        ...(reasonCategory ? { reasonCategory } : {}),
      });
      print(
        `[decision] ${updated.status} ${updated.id} by ${decidedBy} (auth=${updated.decidedAuthMethod})`
      );
      return json(res, 200, {
        ok: true,
        status: updated.status,
        requestId: updated.id,
        authMethod: updated.decidedAuthMethod,
      });
    } catch (error) {
      return json(res, 409, {
        ok: false,
        error: 'internal error',
      });
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const pathname = String(req.url || '').split(/[?#]/)[0];
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          // Request locale like the pads: ?lang= → kb-ui-locale cookie → Accept-Language.
          res.end(renderPage(resolvePadLocale(req)));
          return;
        }
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200);
          res.end('ok');
          return;
        }
        if (req.method === 'GET' && req.url === '/approval') {
          const approval = currentApproval();
          return json(res, 200, {
            ok: true,
            approval: approval
              ? { id: approval.id, status: approval.status, decidedBy: approval.decidedBy }
              : null,
          });
        }
        if (req.method === 'POST' && req.url === '/decision') {
          await handleDecision(req, res);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      } catch (error) {
        json(res, 500, {
          ok: false,
          error: 'internal error',
        });
      }
    })();
  });

  server.listen(port, '127.0.0.1', () => {
    const approval = currentApproval();
    print(`Mission brief approval surface → http://127.0.0.1:${port}/`);
    print(`  mission  : ${missionId}`);
    print(`  brief    : ${briefPath}`);
    print(
      `  approval : ${approval ? `${approval.id} (${approval.status})` : catalogT('mission_alignment:server_approval_missing')}`
    );
    print(`  token    : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only, authMethod=local_token)`);
    print(`  ${catalogT('mission_alignment:server_decision_notice')}`);
  });
}

export const runServeBrief = defineScript({
  name: 'mission-alignment:serve-brief',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'serve-brief.ts') ||
  isDirectScript(import.meta.url, 'serve-brief.js')
)
  void runServeBrief();
