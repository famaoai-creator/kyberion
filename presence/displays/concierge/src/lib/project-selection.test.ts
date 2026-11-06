import { describe, expect, it } from 'vitest';
import {
  projectHintFromQuery,
  projectSwitchHref,
  resolveSelectedProject,
  withProjectScope,
} from './project-selection';

const P1 = { project_id: 'PRJ-ONE', name: 'One', organization_id: 'acme' };
const P2 = { project_id: 'PRJ-TWO', name: 'Two', organization_id: 'acme-labs' };

describe('resolveSelectedProject', () => {
  it('honours only an offered project', () => {
    expect(resolveSelectedProject({ project_id: 'PRJ-ONE' }, [P1, P2])).toBe(P1);
    expect(resolveSelectedProject({ project_id: 'PRJ-GHOST' }, [P1, P2])).toBeNull();
    expect(resolveSelectedProject({ project_id: '' }, [P1])).toBeNull();
  });

  it('refuses a project paired with another organization', () => {
    expect(
      resolveSelectedProject({ project_id: 'PRJ-TWO', organization_id: 'acme' }, [P1, P2])
    ).toBeNull();
  });

  it('reads snake and camel case hints', () => {
    expect(
      projectHintFromQuery(new URLSearchParams('projectId=PRJ-ONE&organizationId=acme'))
    ).toEqual({ project_id: 'PRJ-ONE', organization_id: 'acme' });
  });
});

describe('projectSwitchHref', () => {
  it('sets organization and project, keeping the company and filters', () => {
    const href = projectSwitchHref('https://x.test/work?tenant=acme&reason=approval', P2);
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/work');
    expect(url.searchParams.get('tenant')).toBe('acme');
    expect(url.searchParams.get('reason')).toBe('approval');
    expect(url.searchParams.get('organization_id')).toBe('acme-labs');
    expect(url.searchParams.get('project_id')).toBe('PRJ-TWO');
  });

  it('drops the project, its organization and row selections for every project', () => {
    const href = projectSwitchHref(
      'https://x.test/ops?tenant=acme&organization_id=acme&project_id=PRJ-ONE&mission=MSN-1',
      null
    );
    const url = new URL(href, 'https://x.test');
    expect(url.searchParams.get('tenant')).toBe('acme');
    expect(url.searchParams.has('project_id')).toBe(false);
    expect(url.searchParams.has('organization_id')).toBe(false);
    expect(url.searchParams.has('mission')).toBe(false);
  });
});

describe('withProjectScope', () => {
  it('copies the page project onto an API path', () => {
    expect(
      withProjectScope(
        '/api/v1/needs-you?reason=approval',
        '?tenant=acme&organization_id=acme&project_id=PRJ-ONE'
      )
    ).toBe('/api/v1/needs-you?reason=approval&project_id=PRJ-ONE&organization_id=acme');
  });

  it('leaves the path alone without a page project', () => {
    expect(withProjectScope('/api/v1/home', '?tenant=acme&organization_id=acme')).toBe(
      '/api/v1/home'
    );
  });
});
