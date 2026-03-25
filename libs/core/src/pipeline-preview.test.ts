import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../secure-io.js', () => ({
  safeReadFile: (p: string, opts: any) => fs.readFileSync(p, opts.encoding),
  safeExistsSync: (p: string) => fs.existsSync(p),
}));

import { previewPipeline } from './pipeline-preview.js';

describe('pipeline-preview', () => {
  describe('previewPipeline', () => {
    it('with valid pipeline returns valid: true', () => {
      const pipeline = {
        steps: [
          { id: 'step1', type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
          { id: 'step2', type: 'capture', op: 'screenshot', params: { path: '/tmp/shot.png' } },
        ],
      };

      const result = previewPipeline(pipeline);

      expect(result.valid).toBe(true);
      expect(result.totalSteps).toBe(2);
      expect(result.steps).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it('with missing steps returns valid: false', () => {
      const result = previewPipeline({});

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Pipeline has no steps array');
    });

    it('detects unresolved variables as warnings', () => {
      const pipeline = {
        steps: [
          { id: 'step1', type: 'capture', op: 'goto', params: { url: '{{target_url}}' } },
        ],
      };

      const result = previewPipeline(pipeline);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('Unresolved variable'))).toBe(true);
      expect(result.warnings.some(w => w.includes('target_url'))).toBe(true);
    });

    it('expands ref sub-pipelines into children', () => {
      // Create a temp sub-pipeline file
      const subPipeline = {
        steps: [
          { id: 'sub1', type: 'capture', op: 'click', params: { selector: '#btn' } },
          { id: 'sub2', type: 'capture', op: 'wait', params: { duration: 1000 } },
        ],
      };
      const tmpPath = '/tmp/test-preview-sub-pipeline.json';
      fs.writeFileSync(tmpPath, JSON.stringify(subPipeline));

      try {
        const pipeline = {
          steps: [
            { id: 'ref-step', type: 'control', op: 'ref', params: { path: tmpPath } },
          ],
        };

        const result = previewPipeline(pipeline);

        expect(result.steps[0].children).toBeDefined();
        expect(result.steps[0].children).toHaveLength(2);
        // totalSteps should include the ref step + 2 children
        expect(result.totalSteps).toBe(3);
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });

    it('includes else branch steps for if control flow', () => {
      const pipeline = {
        steps: [
          {
            id: 'if-step',
            type: 'control',
            op: 'if',
            params: {
              condition: { from: 'ctx.ready', operator: 'eq', value: true },
              then: [{ id: 'then-1', type: 'apply', op: 'log', params: { message: 'then' } }],
              else: [{ id: 'else-1', type: 'apply', op: 'log', params: { message: 'else' } }],
            },
          },
        ],
      };

      const result = previewPipeline(pipeline);

      expect(result.steps[0].children).toHaveLength(2);
      expect(result.totalSteps).toBe(3);
      expect(result.steps[0].description).toContain('else: 1 steps');
    });
  });

  describe('describeStep (via previewPipeline)', () => {
    it('returns human-readable descriptions for common ops', () => {
      const pipeline = {
        steps: [
          { id: 's1', type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
          { id: 's2', type: 'capture', op: 'click', params: { selector: '#submit' } },
          { id: 's3', type: 'capture', op: 'fill', params: { selector: '#name' } },
          { id: 's4', type: 'capture', op: 'screenshot', params: { path: '/tmp/s.png' } },
          { id: 's5', type: 'capture', op: 'wait', params: { duration: 500 } },
          { id: 's6', type: 'control', op: 'log', params: { message: 'done' } },
        ],
      };

      const result = previewPipeline(pipeline);

      expect(result.steps[0].description).toContain('Navigate to');
      expect(result.steps[1].description).toContain('Click');
      expect(result.steps[2].description).toContain('Fill');
      expect(result.steps[3].description).toContain('screenshot');
      expect(result.steps[4].description).toContain('Wait');
      expect(result.steps[5].description).toContain('Log');
    });
  });
});
