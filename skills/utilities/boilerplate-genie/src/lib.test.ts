import { describe, it, expect } from 'vitest';
import { generateBoilerplate, ProjectType } from './lib';

describe('boilerplate-genie lib', () => {
  it('should generate node boilerplate', () => {
    const files = generateBoilerplate({ name: 'my-app', type: ProjectType.NODE });
    expect(files['package.json']).toContain('"name": "my-app"');
    expect(files['index.js']).toContain('console.log');
  });

  it('should generate generic boilerplate', () => {
    const files = generateBoilerplate({ name: 'my-project', type: ProjectType.GENERIC });
    expect(files['README.md']).toContain('# my-project');
  });
});
