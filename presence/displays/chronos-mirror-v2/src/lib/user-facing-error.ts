import { uxText, uxTextOr } from './ux-vocabulary';

type Locale = 'en' | 'ja';

export interface UserFacingErrorEnvelope {
  title: string;
  body: string;
  nextAction: string;
  traceLine?: string;
}

function normalizeLocale(locale?: string): Locale {
  return String(locale || '')
    .trim()
    .toLowerCase()
    .startsWith('ja')
    ? 'ja'
    : 'en';
}

function categoryFromMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('etimedout')
  )
    return 'timeout';
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('connection')
  )
    return 'network';
  if (
    normalized.includes('approval') ||
    normalized.includes('policy') ||
    normalized.includes('permission') ||
    normalized.includes('tier_violation') ||
    normalized.includes('policy_violation')
  )
    return 'governance_block';
  if (
    normalized.includes('secret') ||
    normalized.includes('credential') ||
    normalized.includes('api key')
  )
    return 'missing_secret';
  if (
    normalized.includes('module not found') ||
    normalized.includes('not installed') ||
    normalized.includes('enoent')
  )
    return 'missing_dependency';
  if (
    normalized.includes('schema') ||
    normalized.includes('invalid') ||
    normalized.includes('unexpected token')
  )
    return 'invalid_input';
  if (
    normalized.includes('eaddrinuse') ||
    normalized.includes('no space left') ||
    normalized.includes('resource busy') ||
    normalized.includes('locked')
  )
    return 'resource_unavailable';
  if (normalized.includes('mission not found')) return 'mission_not_found';
  if (normalized.includes('unauthorized') || normalized.includes('invalid api key')) return 'auth';
  return 'unknown';
}

function bodyKey(category: string): string {
  switch (category) {
    case 'network':
      return 'error_connection_body';
    case 'timeout':
      return 'error_timeout_body';
    case 'governance_block':
      return 'error_governance_block_body';
    case 'missing_secret':
      return 'error_missing_secret_body';
    case 'missing_dependency':
      return 'error_missing_dependency_body';
    case 'invalid_input':
      return 'error_invalid_input_body';
    case 'resource_unavailable':
      return 'error_resource_unavailable_body';
    case 'mission_not_found':
      return 'error_mission_not_found_body';
    case 'auth':
    case 'permission_denied':
      return 'error_permission_denied_body';
    default:
      return 'error_unknown_body';
  }
}

function nextActionKey(category: string): string {
  switch (category) {
    case 'network':
      return 'error_next_step_connect';
    case 'timeout':
      return 'error_next_step_retry';
    case 'governance_block':
    case 'permission_denied':
      return 'error_next_step_repair';
    case 'missing_secret':
      return 'error_next_step_secret';
    case 'missing_dependency':
      return 'error_next_step_doctor';
    case 'invalid_input':
      return 'error_next_step_input';
    case 'resource_unavailable':
    case 'mission_not_found':
    default:
      return 'error_next_step_retry';
  }
}

export function buildUserFacingError(
  err: unknown,
  opts: { locale?: string; surface?: string; traceId?: string } = {}
): UserFacingErrorEnvelope {
  const locale = normalizeLocale(opts.locale);
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
  const category = categoryFromMessage(message);
  const surfacePrefix = opts.surface ? `${opts.surface}: ` : '';

  return {
    title: uxText('error_title', locale),
    body: `${surfacePrefix}${uxTextOr(bodyKey(category), 'The request could not be completed.', locale)}`,
    nextAction: uxTextOr(nextActionKey(category), 'Try the request again.', locale),
    traceLine: opts.traceId ? `${uxText('error_trace_label', locale)} ${opts.traceId}` : undefined,
  };
}
