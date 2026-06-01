import { describe, expect, it } from 'vitest';

import {
  loadMissionDistillMarkdownPolicyCatalog,
  resolveMissionDistillMarkdownPolicy,
} from './mission-distill-markdown-policy.js';

describe('mission-distill-markdown-policy', () => {
  it('loads the canonical mission distill markdown policy', () => {
    const catalog = loadMissionDistillMarkdownPolicyCatalog();
    expect(catalog.title_suffix).toBe('Completion Summary');
    expect(catalog.section_titles.summary).toBe('Summary');
    expect(catalog.section_titles.key_learnings).toBe('Key Learnings');
    expect(catalog.prompt_titles.mission_state).toBe('Mission State');
  });

  it('resolves the mission distill markdown policy object', () => {
    const policy = resolveMissionDistillMarkdownPolicy();
    expect(policy.section_titles.reusable_artifacts).toBe('Reusable Artifacts');
  });
});
