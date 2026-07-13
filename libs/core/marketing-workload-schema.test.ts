import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const schema = JSON.parse(
  safeReadFile(pathResolver.knowledge('product/schemas/marketing-workload.schema.json'), {
    encoding: 'utf8',
  }) as string
);
const example = JSON.parse(
  safeReadFile(pathResolver.knowledge('product/schemas/marketing-workload.example.json'), {
    encoding: 'utf8',
  }) as string
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('marketing workload schema', () => {
  it('accepts the canonical example', () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects missing intake requirements and invalid risk levels', () => {
    expect(validate({ intake: { risk_level: 9 }, claim_register: [] })).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === 'required')).toBe(true);
    expect(validate.errors?.some((error) => error.keyword === 'maximum')).toBe(true);
  });

  it('rejects invalid review verdicts and malformed approval hashes', () => {
    const invalid = {
      ...example,
      reviews: [
        {
          review_id: 'r1',
          artifact_path: 'video.mp4',
          artifact_sha256: 'a'.repeat(64),
          reviewer_role: 'legal-reviewer',
          verdict: 'looks_good',
          findings: [],
        },
      ],
      publication_approval: {
        approval_id: 'a1',
        mission_id: 'm1',
        approved_artifacts: { video: { path: 'video.mp4', sha256: 'bad' } },
        destination: { service: 'youtube', account: 'official', visibility: 'unlisted' },
        title: 'Title',
        description: '',
        approved_by: ['human:owner'],
        approval_decisions: [
          {
            approved_by: 'human:owner',
            decided_by_type: 'human',
            authenticated: true,
            approved_at: '2026-07-12T00:00:00Z',
          },
        ],
        approved_at: '2026-07-12T00:00:00Z',
        expires_at: '2026-07-13T00:00:00Z',
        risk_level: 2,
        review_ids: ['r1'],
        shared_approval: {
          storage_channel: 'terminal',
          request_id: '00000000-0000-4000-8000-000000000001',
          payload_hash: 'a'.repeat(64),
          effect_binding: 'marketing-publication:m1',
        },
      },
    };
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === 'enum')).toBe(true);
    expect(validate.errors?.some((error) => error.keyword === 'pattern')).toBe(true);
  });
});
