import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { conciergeText } from '../../../lib/i18n';
import { CompanySetupView } from './CompanySetupView';
import {
  initialCompanyState,
  type CompanySetupState,
  type CompanyStage,
} from './company-setup-model';

function state(stage: CompanyStage): CompanySetupState {
  return {
    ...initialCompanyState('company-a'),
    tenants: [{ slug: 'company-a', name: 'Example Company' }],
    setup: {
      tenantSlug: 'company-a',
      companyName: 'Example Company',
      organizationId: 'company-a',
      verticals: ['software'],
      firstWork: 'Prepare a report',
      stage,
      blockers: [],
      probePassed: false,
      probeSummary: [],
      canRequestActivation: false,
      ...(stage === 'awaiting_approval'
        ? {
            activationApproval: {
              id: 'APR-1',
              channel: 'concierge',
              presentedDigest: 'proof-1',
              status: 'pending',
            },
          }
        : {}),
    },
  };
}
function props(snapshot: CompanySetupState) {
  return {
    state: snapshot,
    t: (key: Parameters<typeof conciergeText>[0]) => conciergeText(key, 'en'),
    changeTenant: vi.fn(),
    updateDraft: vi.fn(),
    act: vi.fn(),
    refresh: vi.fn(),
    dismissReview: vi.fn(),
  };
}
function markup(snapshot: CompanySetupState) {
  return renderToStaticMarkup(React.createElement(CompanySetupView, props(snapshot)));
}
type Element = React.ReactElement<Record<string, unknown>>;
function elements(value: React.ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement(value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children as React.ReactNode)];
}
describe('company setup stage UI contract (synthetic rendering, not browser QA)', () => {
  it('requires preview before registration and locks the existing company name', () => {
    const html = markup(state('unregistered'));
    expect(html).toContain('Preview registration');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('value="Example Company"');
    expect(html).not.toContain('Register this company setup');
    expect(html).toContain('href="/setup/first-run"');
    expect(html).toContain('aria-current="step"');
  });
  it('makes human approval a queue handoff and keeps activation disabled until approved', () => {
    const html = markup(state('awaiting_approval'));
    expect(html).toContain('href="/?tenant=company-a#decide-approval-APR-1"');
    expect(html).toContain('Return here and refresh');
    expect(html).toContain('Apply approved activation');
    expect(html).not.toContain('proof-1');
    expect(html).not.toContain('/api/approvals/');
    const p = props(state('awaiting_approval'));
    const tree = elements(CompanySetupView(p));
    const button = tree.find(
      (row) => row.type === 'button' && row.props.children === 'Apply approved activation'
    )!;
    expect(button.props.disabled).toBe(true);
  });
  it('separates activation, first-work preview, and preparation without claiming execution', () => {
    const active = markup(state('active'));
    expect(active).toContain('Preview first-work preparation');
    expect(active).not.toContain('Save first-work preparation');
    const prepared = markup(state('first_work_prepared'));
    expect(prepared).toContain('No work has been executed');
    expect(prepared).not.toContain('Preview first-work preparation');
    expect(prepared).toContain('href="/management?tenant=company-a&amp;organization_id=company-a"');
  });
  it('shows the exact server preview with explicit apply and cancel controls', () => {
    const snapshot = state('active');
    snapshot.review = {
      action: 'apply_first_work',
      digest: 'review-1',
      title: '<script>Plan</script>',
      summary: ['Review this plan'],
    };
    const html = markup(snapshot);
    expect(html).toContain('&lt;script&gt;Plan&lt;/script&gt;');
    expect(html).toContain('Save first-work preparation');
    expect(html).toContain('Cancel review');
    const p = props(snapshot);
    const tree = elements(CompanySetupView(p));
    const apply = tree.find(
      (row) => row.type === 'button' && row.props.children === 'Save first-work preparation'
    )!;
    (apply.props.onClick as () => void)();
    expect(p.act).toHaveBeenCalledExactlyOnceWith('apply_first_work');
    const cancel = tree.find(
      (row) => row.type === 'button' && row.props.children === 'Cancel review'
    )!;
    (cancel.props.onClick as () => void)();
    expect(p.dismissReview).toHaveBeenCalledOnce();
  });
  it('renders unknown outcomes as a refresh requirement with all writes disabled', () => {
    const snapshot = { ...state('registered'), notice: 'uncertain' as const, needsRefresh: true };
    const html = markup(snapshot);
    expect(html).toContain('role="alert"');
    expect(html).toContain('It has not been retried');
    const tree = elements(CompanySetupView(props(snapshot)));
    const buttons = tree.filter((row) => row.type === 'button');
    expect(
      buttons.filter((row) => row.props.disabled !== true).map((row) => row.props.children)
    ).toEqual(['Refresh status']);
  });
});
