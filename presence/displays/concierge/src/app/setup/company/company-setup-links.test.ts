import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { conciergeText } from '../../../lib/i18n';
import type { ManagementData } from '../../management/management-client';

vi.mock('../../../lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({
    locale: 'en',
    t: (key: Parameters<typeof conciergeText>[0]) => conciergeText(key, 'en'),
  }),
}));
import { ManagementOverview } from '../../management/ManagementOverview';

const data: ManagementData = {
  ok: true,
  contextId: 'test-context',
  actorId: 'user:owner',
  tenants: [{ slug: 'company-a', name: 'Company A' }],
  organizations: [],
  projects: [],
  selected: { tenant: 'company-a', organizationId: '', projectId: '' },
  canManage: true,
  capabilities: {
    createOrganization: true,
    createProject: true,
    editOrganization: false,
    editProject: false,
  },
  organization: null,
  project: null,
};
function render(snapshot: ManagementData, denied = false) {
  return renderToStaticMarkup(
    React.createElement(ManagementOverview, {
      scope: snapshot.selected,
      data: snapshot,
      busy: false,
      writeBlocked: false,
      expired: false,
      denied,
      tenants: snapshot.tenants,
      missions: null,
      changeScope: vi.fn(),
      start: vi.fn(),
    })
  );
}
describe('company setup management entry', () => {
  it('offers setup for an owned empty company with only its selected slug in the link', () => {
    expect(render(data)).toContain('href="/setup/company?tenant=company-a"');
    expect(render(data)).toContain('Set up this company');
  });
  it('does not offer the empty-state setup shortcut for denied or populated organizations', () => {
    expect(render(data, true)).not.toContain('href="/setup/company');
    expect(
      render({ ...data, organizations: [{ id: 'org-a', name: 'Existing', status: 'active' }] })
    ).not.toContain('href="/setup/company');
  });
});
