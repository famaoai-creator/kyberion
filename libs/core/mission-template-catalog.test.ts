import { describe, expect, it } from 'vitest';
import { loadMissionTemplateCatalog, validateMissionTemplateCatalog } from './mission-creation.js';

describe('mission template catalog', () => {
  it('loads the mission creation templates through the governed catalog', () => {
    const catalog = loadMissionTemplateCatalog();
    expect(catalog.templates.map((template) => template.name)).toEqual([
      'development',
      'meeting_facilitation',
    ]);
    expect(catalog.templates[0]?.files[0]?.path).toBe('mission-state.json');
  });

  it('rejects unknown template fields and escaping file paths', () => {
    expect(() =>
      validateMissionTemplateCatalog({
        templates: [
          {
            name: 'unsafe',
            files: [{ path: '../outside.txt', content_template: 'x' }],
            unexpected: true,
          },
        ],
      })
    ).toThrow(/Invalid catalog mission-templates/);
  });
});
