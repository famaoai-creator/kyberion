import { describe, expect, it } from 'vitest';
import {
  findTrainingTrack,
  loadTrainingCatalog,
  trainingAssignmentsPath,
  trainingProgressPath,
} from './training-catalog.js';

describe('training catalog', () => {
  it('loads the three bounded learning tracks through the governed catalog', () => {
    const catalog = loadTrainingCatalog();
    expect(catalog.tracks.map((track) => track.id)).toEqual([
      'first-steps',
      'guided-work',
      'team-practice',
    ]);
    expect(findTrainingTrack('first-steps')?.lessons[0].try.kind).toBe('ask');
    expect(findTrainingTrack('first-steps')?.lessons[0].try.prefill).toBeTruthy();
  });

  it('keeps progress personal and assignments tenant-confidential', () => {
    expect(trainingProgressPath('alice')).toContain(
      'knowledge/personal/members/alice/training.json'
    );
    expect(trainingAssignmentsPath('acme-corp')).toContain(
      'knowledge/confidential/acme-corp/training/assignments.json'
    );
    expect(() => trainingProgressPath('../escape')).toThrow('invalid member id');
    expect(() => trainingAssignmentsPath('personal')).toThrow('invalid tenant slug');
  });
});
