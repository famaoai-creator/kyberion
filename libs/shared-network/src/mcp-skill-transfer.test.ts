import { describe, expect, it } from 'vitest';
import {
  getTransferableSkill,
  listTransferableSkills,
  parseSkillResourceUri,
  readTransferableSkillBody,
} from './mcp-skill-transfer.js';

describe('mcp-skill-transfer', () => {
  it('lists first-party plugin skills with kyberion:// URIs', () => {
    const skills = listTransferableSkills();
    expect(skills.length).toBeGreaterThan(0);
    const root = skills.find((s) => s.plugin_id === 'kyberion' && s.skill_id === 'kyberion');
    expect(root).toBeTruthy();
    expect(root?.uri).toBe('kyberion://skill/kyberion/kyberion');
    expect(root?.title).toBeTruthy();
  });

  it('reads skill body for getTransferableSkill', () => {
    const skill = getTransferableSkill('kyberion', 'kyberion');
    expect(skill).toBeTruthy();
    const body = readTransferableSkillBody(skill!);
    expect(body).toContain('Kyberion');
    expect(body).toMatch(/^---/);
  });

  it('parses skill resource URIs', () => {
    expect(parseSkillResourceUri('kyberion://skill/kyberion/kyberion')).toEqual({
      plugin_id: 'kyberion',
      skill_id: 'kyberion',
    });
    expect(parseSkillResourceUri('https://example.com')).toBeNull();
  });
});
