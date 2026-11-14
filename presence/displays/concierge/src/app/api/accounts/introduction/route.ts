import { NextRequest, NextResponse } from 'next/server';
import {
  previewAccountIntroduction,
  proposeAccountIntroduction,
  accountIntroductionStatus,
  applyAccountIntroduction,
} from '@agent/core/secret/account-introduction';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';
import { readRequestObject } from '../../../../lib/request-input';
import { requireConciergeInstallationAccess } from '../../../../lib/installation-access';
import { asOnboardingOwner } from '../../../../lib/onboarding-authority-server';
import { accountIntroductionAccess } from '../../../../lib/account-introduction-server';

export const dynamic = 'force-dynamic';
const response = (value: unknown, status = 200) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const invalid = () => response({ ok: false, error: 'invalid_account_request' }, 400);

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const parsed = await readRequestObject(req, 'request body', [
    'action',
    'binding_id',
    'digest',
    'expected_generation',
    'approval_id',
    'material',
  ]);
  if (!parsed.ok) return invalid();
  const { body } = parsed;
  const { action, binding_id: bindingId } = body;
  const keys: Record<string, string[]> = {
    preview: [],
    request: ['digest', 'expected_generation'],
    status: ['approval_id'],
    apply: ['approval_id', 'material'],
  };
  if (
    typeof action !== 'string' ||
    !Object.hasOwn(keys, action) ||
    typeof bindingId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bindingId) ||
    Object.keys(body).some((key) => !['action', 'binding_id', ...keys[action]!].includes(key))
  )
    return invalid();
  try {
    const { principal, scope } = accountIntroductionAccess(resolved.context, bindingId);
    if (scope.kind === 'person' && ['request', 'apply'].includes(action)) {
      const gate = requireConciergeInstallationAccess(
        resolved.context,
        'write',
        req,
        `account_introduction ${action}`
      );
      if (gate.response) return gate.response;
    }
    const result = await asOnboardingOwner(() => {
      if (action === 'preview') return previewAccountIntroduction(principal, bindingId);
      if (action === 'request') {
        if (
          typeof body.digest !== 'string' ||
          (body.expected_generation !== null && typeof body.expected_generation !== 'string')
        )
          return null;
        return proposeAccountIntroduction(principal, bindingId, {
          digest: body.digest,
          expected_generation: body.expected_generation,
        });
      }
      if (typeof body.approval_id !== 'string' || body.approval_id.length > 128) return null;
      if (action === 'status')
        return accountIntroductionStatus(principal, bindingId, body.approval_id);
      const material = body.material;
      if (!material || typeof material !== 'object' || Array.isArray(material)) return null;
      const entries = Object.entries(material);
      if (
        !entries.length ||
        entries.length > 64 ||
        entries.some(
          ([key, value]) =>
            !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) ||
            typeof value !== 'string' ||
            !value ||
            Buffer.byteLength(value, 'utf8') > 16 * 1024
        )
      )
        return null;
      return applyAccountIntroduction(principal, bindingId, {
        approval_id: body.approval_id,
        material: Object.fromEntries(entries) as Record<string, string>,
      });
    });
    return result ? response({ ...result, ok: true }) : invalid();
  } catch (error) {
    // Never echo provider errors, submitted values, paths, or storage details.
    return response(
      {
        ok: false,
        error:
          error instanceof Error && error.message === '[ACCOUNT_INTRODUCTION] recovery_required'
            ? 'account_recovery_required'
            : 'account_registration_unavailable',
      },
      409
    );
  }
}
