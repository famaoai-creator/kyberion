export type CompanyStage =
  'unregistered' | 'registered' | 'awaiting_approval' | 'active' | 'first_work_prepared';
export type CompanySetup = {
  tenantSlug: string;
  companyName: string;
  organizationId: string;
  verticals: string[];
  stage: CompanyStage;
  firstWork: string;
  blockers: string[];
  probePassed: boolean;
  probeSummary: string[];
  canRequestActivation: boolean;
  registrationState?: 'started' | 'completed' | 'failed';
  activationApproval?: {
    id: string;
    channel: string;
    presentedDigest: string;
    status: string;
  };
};
export type CompanyReview = { digest: string; title: string; summary: string[] };
export type CompanyAction =
  | 'preview_company'
  | 'register_company'
  | 'probe'
  | 'request_activation'
  | 'apply_activation'
  | 'preview_first_work'
  | 'apply_first_work';
export type CompanyNotice = 'failed' | 'expired' | 'forbidden' | 'changed' | 'uncertain';
export type CompanySetupState = {
  tenantSlug: string;
  tenants: { slug: string; name: string }[];
  setup: CompanySetup | null;
  review: (CompanyReview & { action: 'register_company' | 'apply_first_work' }) | null;
  draft: { vertical: string; firstWork: string };
  busy: boolean;
  notice: CompanyNotice | null;
  needsRefresh: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
export function parseCompanySetup(value: unknown, tenantSlug: string): CompanySetup | null {
  if (!record(value) || value.ok !== true || !record(value.setup)) return null;
  const setup = value.setup;
  if (
    setup.tenantSlug !== tenantSlug ||
    !text(setup.companyName) ||
    !text(setup.organizationId) ||
    !strings(setup.verticals) ||
    !text(setup.stage) ||
    !['unregistered', 'registered', 'awaiting_approval', 'active', 'first_work_prepared'].includes(
      setup.stage
    ) ||
    !text(setup.firstWork) ||
    !strings(setup.blockers) ||
    typeof setup.probePassed !== 'boolean' ||
    !strings(setup.probeSummary) ||
    typeof setup.canRequestActivation !== 'boolean'
  )
    return null;
  if (
    setup.registrationState !== undefined &&
    !['started', 'completed', 'failed'].includes(String(setup.registrationState))
  )
    return null;
  const approval = setup.activationApproval;
  if (
    approval !== undefined &&
    (!record(approval) ||
      !['id', 'channel', 'presentedDigest', 'status'].every((key) => text(approval[key])))
  )
    return null;
  return setup as CompanySetup;
}
export function parseCompanyReview(value: unknown): CompanyReview | null {
  if (!record(value) || value.ok !== true || !record(value.review)) return null;
  const review = value.review;
  return text(review.digest) && !!review.digest && text(review.title) && strings(review.summary)
    ? { digest: review.digest, title: review.title, summary: review.summary }
    : null;
}
export function initialCompanyState(tenantSlug = ''): CompanySetupState {
  return {
    tenantSlug,
    tenants: [],
    setup: null,
    review: null,
    draft: { vertical: '', firstWork: '' },
    busy: false,
    notice: null,
    needsRefresh: false,
  };
}
/** Explicit transitions only. A local stage or approval label never grants server authority. */
export function companyActionAllowed(state: CompanySetupState, action: CompanyAction): boolean {
  if (state.busy || state.needsRefresh || !state.setup) return false;
  const { stage, activationApproval, canRequestActivation, probePassed, registrationState } =
    state.setup;
  if (registrationState === 'started' || registrationState === 'failed') return false;
  switch (action) {
    case 'preview_company':
      return (
        stage === 'unregistered' &&
        state.setup.verticals.includes(state.draft.vertical) &&
        !!state.draft.firstWork.trim()
      );
    case 'register_company':
      return stage === 'unregistered' && state.review?.action === action;
    case 'probe':
      return stage === 'registered';
    case 'request_activation':
      return stage === 'registered' && probePassed && canRequestActivation;
    case 'apply_activation':
      return stage === 'awaiting_approval' && activationApproval?.status === 'approved';
    case 'preview_first_work':
      return stage === 'active';
    case 'apply_first_work':
      return stage === 'active' && state.review?.action === action;
  }
}
export function companySetupHref(tenantSlug: string): string {
  return '/setup/company?' + new URLSearchParams({ tenant: tenantSlug }).toString();
}
export function companyApprovalHref(setup: CompanySetup): string {
  const anchor = setup.activationApproval
    ? 'decide-approval-' + encodeURIComponent(setup.activationApproval.id)
    : 'decide-heading';
  return '/?' + new URLSearchParams({ tenant: setup.tenantSlug }).toString() + '#' + anchor;
}
