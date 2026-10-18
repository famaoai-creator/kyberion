import { describe, expect, it } from 'vitest';
import {
  discussionArtifactUrlForDeliverable,
  savedDiscussionArtifactUrl,
} from './discussion-artifact-url';

describe('saved discussion URLs', () => {
  it('routes the two saved room artifacts separately from generated review HTML', () => {
    for (const [name, kind] of [
      ['minutes.md', 'markdown'],
      ['brief.html', 'html'],
    ]) {
      expect(
        discussionArtifactUrlForDeliverable({
          artifactId: 'ART-1',
          kind,
          storageClass: 'repo',
          path: 'active/shared/runtime/discussions/disc-1/' + name,
        })
      ).toBe('/api/discussions/disc-1/artifacts/ART-1');
    }
    expect(savedDiscussionArtifactUrl('disc/1', 'ART?#')).toBe(
      '/api/discussions/disc%2F1/artifacts/ART%3F%23'
    );
  });
  it('does not interpret other runtime files, noncanonical paths, or kinds as saved artifacts', () => {
    for (const path of [
      'active/shared/runtime/discussions/../brief.html',
      'active/shared/runtime/discussions/disc-1/events.jsonl',
      'active/shared/runtime/discussions/disc-1/attachments/brief.html',
      'active/shared/runtime/discussions//disc-1/brief.html',
      'active/shared/runtime/discussions/disc-1/../brief.html',
      'active/shared/exports/brief.html',
    ]) {
      expect(
        discussionArtifactUrlForDeliverable({
          artifactId: 'ART-1',
          kind: 'html',
          storageClass: 'repo',
          path,
        })
      ).toBeNull();
    }
    expect(
      discussionArtifactUrlForDeliverable({
        artifactId: 'ART-1',
        kind: 'pdf',
        storageClass: 'repo',
        path: 'active/shared/runtime/discussions/disc-1/brief.html',
      })
    ).toBeNull();
    expect(
      discussionArtifactUrlForDeliverable({
        artifactId: 'ART-1',
        kind: 'html',
        storageClass: 'external_ref',
        path: 'active/shared/runtime/discussions/disc-1/brief.html',
      })
    ).toBeNull();
  });
});
