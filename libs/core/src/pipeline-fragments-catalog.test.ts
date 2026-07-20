import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previewPipeline } from './pipeline-preview.js';

const ROOT = process.cwd();

const FRAGMENTS: Array<{
  file: string;
  requiredOps: string[];
}> = [
  {
    file: 'pipelines/fragments/browser-research-capture.json',
    requiredOps: ['browser:goto', 'browser:snapshot', 'file:write'],
  },
  {
    file: 'pipelines/fragments/system-runtime-diagnostic.json',
    requiredOps: [
      'system:cli_health_check',
      'system:list_tool_runtimes',
      'system:list_service_runtimes',
    ],
  },
  {
    file: 'pipelines/fragments/service-reachability-smoke.json',
    requiredOps: ['service:preset', 'system:log'],
  },
  {
    file: 'pipelines/fragments/voice-production-pack.json',
    requiredOps: ['voice:health', 'voice:list_voices', 'voice:generate_voice', 'voice:speak_local'],
  },
  {
    file: 'pipelines/fragments/wisdom-sdlc-pack.json',
    requiredOps: [
      'modeling:extract_requirements',
      'modeling:extract_design_spec',
      'modeling:extract_test_plan',
      'orchestrator:decompose_into_tasks',
    ],
  },
  {
    file: 'pipelines/fragments/meeting-participation-pack-fragment.json',
    requiredOps: ['meeting:status', 'meeting:join', 'meeting:listen', 'meeting:leave'],
  },
  {
    file: 'pipelines/fragments/media-pptx-roundtrip-pack-fragment.json',
    requiredOps: [
      'media:pptx_extract',
      'media:document_digest',
      'media:pptx_render',
      'system:write_file',
    ],
  },
  {
    file: 'pipelines/fragments/software-qa-lifecycle.json',
    requiredOps: ['system:exec', 'system:log'],
  },
];

describe('pipeline fragments catalog', () => {
  for (const fragment of FRAGMENTS) {
    it(`keeps ${fragment.file} structurally valid`, () => {
      const filePath = path.join(ROOT, fragment.file);
      const pipeline = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      expect(pipeline.action).toBe('pipeline');
      expect(Array.isArray(pipeline.steps)).toBe(true);
      expect(pipeline.steps.length).toBeGreaterThanOrEqual(3);

      const result = previewPipeline(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.steps.length).toBeGreaterThan(0);

      const serialized = JSON.stringify(pipeline);
      for (const op of fragment.requiredOps) {
        expect(serialized).toContain(`"op":"${op}"`);
      }
    });
  }
});
