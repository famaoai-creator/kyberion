import { expect, it } from 'vitest';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { selectScopedProjectTrack } from './project-track-scope.js';
import type { ProjectTrackRecord } from './project-track-registry.js';

const project = { project_id: 'project-a', tenant_slug: 'tenant-a', tier: 'confidential' } as const;
const track: ProjectTrackRecord = {
  ...project,
  track_id: 'delivery',
  name: 'Delivery',
  summary: 'Existing delivery work',
  status: 'active',
  track_type: 'delivery',
  lifecycle_model: 'sdlc',
};
const variants: Array<Partial<ProjectTrackRecord>> = [
  {},
  { project_id: 'project-b' },
  { tenant_slug: 'tenant-b' },
  { tenant_slug: undefined },
  { tier: 'public' },
  { status: 'paused' },
];

it('checks selection and scope before admitting a track record', () => {
  type State = { bound: boolean; requested: string; checked?: boolean; violation?: boolean };
  const report = checkFiniteStateSafety<State>({
    initial: [false, true].flatMap((bound) =>
      ['delivery', 'operations'].map((requested) => ({ bound, requested }))
    ),
    key: (state) => JSON.stringify(state),
    next(state) {
      if (state.checked) return [];
      return variants.map((variant, index) => {
        const boundTrackId = state.bound ? 'delivery' : undefined;
        const record = { ...track, ...variant, track_id: boundTrackId || state.requested };
        const admitted = selectScopedProjectTrack({
          project,
          boundTrackId,
          selectedTrackId: state.requested,
          suppliedTrack: { ...record, track_id: state.requested },
          load: (id) => (id === record.track_id ? record : null),
        });
        const shouldAdmit = index === 0 || (index === 5 && state.bound);
        return {
          action: `resolve variant ${index}`,
          state: {
            ...state,
            checked: true,
            violation:
              Boolean(admitted) !== shouldAdmit ||
              Boolean(admitted && admitted.track_id !== (boundTrackId || state.requested)),
          },
        };
      });
    },
    invariants: { staysInScopeAndKeepsStoredBinding: (state) => !state.violation },
  });
  expect(report).toMatchObject({ status: 'verified', transitions: 24 });
});

it('does not substitute an active project default for a missing work binding', () => {
  expect(
    selectScopedProjectTrack({
      project,
      boundTrackId: 'missing',
      selectedTrackId: track.track_id,
      defaultTrackId: track.track_id,
      suppliedTrack: track,
    })
  ).toBeNull();
});
