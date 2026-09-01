import { describe, expect, it } from 'vitest';
import { parseIngestCliVerdict } from './ingest-output-parser.js';

describe('parseIngestCliVerdict', () => {
  it('keeps only typed ingest verdict fields', () => {
    expect(
      parseIngestCliVerdict(
        '[ingest] DRY RUN\n{"dry_run":true,"would_commit":true,"target_path":"public/a.md"}',
        '[ingest] DRY RUN'
      )
    ).toEqual({ dry_run: true, would_commit: true, target_path: 'public/a.md' });
    expect(
      parseIngestCliVerdict('[ingest] committed {"target_path":42}', '[ingest] committed ')
    ).toBeNull();
    expect(parseIngestCliVerdict('[ingest] DRY RUN\n[]', '[ingest] DRY RUN')).toBeNull();
  });
});
