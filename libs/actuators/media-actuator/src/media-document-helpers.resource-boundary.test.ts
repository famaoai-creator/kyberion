import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { normalizeSpreadsheetDocumentBrief } from './media-document-helpers.js';

const ROOT = pathResolver.sharedTmp(`media-document-helpers-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(ROOT, { recursive: true, force: true });
});

describe('media document brief resource boundary', () => {
  it('accepts an object protocol loaded from a repository path', () => {
    const protocolPath = `${ROOT}/protocol.json`;
    safeWriteFile(protocolPath, JSON.stringify({ sheets: [] }));

    expect(
      normalizeSpreadsheetDocumentBrief(pathResolver.rootDir(), {
        kind: 'document-brief',
        artifact_family: 'spreadsheet',
        document_type: 'tracker',
        render_target: 'xlsx',
        payload: { protocol_path: protocolPath },
      }).payload.protocol
    ).toEqual({ sheets: [] });
  });

  it('rejects a protocol containing dangerous JSON keys before compilation', () => {
    const protocolPath = `${ROOT}/unsafe-protocol.json`;
    safeWriteFile(protocolPath, '{"sheets":[],"meta":{"__proto__":{"polluted":true}}}');

    expect(() =>
      normalizeSpreadsheetDocumentBrief(pathResolver.rootDir(), {
        kind: 'document-brief',
        artifact_family: 'spreadsheet',
        document_type: 'tracker',
        render_target: 'xlsx',
        payload: { protocol_path: protocolPath },
      })
    ).toThrow('dangerous JSON key');
  });
});
