import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();
const allowedCoreFsImports = [
  'libs/core/action-item-store.test.ts',
  'libs/core/environment-capability.test.ts',
  'libs/core/evidence-chain.test.ts',
  'libs/core/fs-primitives.ts',
  'libs/core/heuristic-feedback.test.ts',
  'libs/core/intent-snapshot-store.test.ts',
  'libs/core/ledger.test.ts',
  'libs/core/metrics.test.ts',
  'libs/core/mission-evidence-doc.test.ts',
  'libs/core/relationship-graph-store.test.ts',
  'libs/core/requirements-draft-store.test.ts',
  'libs/core/sdlc-artifact-store.test.ts',
  'libs/core/secure-io.branch.test.ts',
  'libs/core/secure-io.test.ts',
  'libs/core/secure-io.ts',
  'libs/core/security-boundary.contract.test.ts',
  'libs/core/speech-to-text-bridge.test.ts',
  'libs/core/src/actuator-capability.test.ts',
  'libs/core/src/feedback-loop.test.ts',
  'libs/core/src/knowledge-index.test.ts',
  'libs/core/validators.test.ts',
  'libs/core/src/native-docx-engine/__tests__/docx-engine.test.ts',
  'libs/core/src/native-docx-engine/engine.ts',
  'libs/core/src/native-docx-engine/examples/roundtrip_docx.ts',
  'libs/core/src/native-pdf-engine/__tests__/pdf-binary.test.ts',
  'libs/core/src/native-pdf-engine/engine.ts',
  'libs/core/src/native-pptx-engine/__tests__/pptx-engine.test.ts',
  'libs/core/src/native-pptx-engine/__tests__/pptx-filter-slides.test.ts',
  'libs/core/src/native-pptx-engine/engine.ts',
  'libs/core/src/native-xlsx-engine/__tests__/xlsx-engine.test.ts',
  'libs/core/src/native-xlsx-engine/engine.ts',
  'libs/core/src/pfc/PfcController.test.ts',
  'libs/core/src/pfc/SovereignSentinel.test.ts',
  'libs/core/src/pipeline-engine.test.ts',
  'libs/core/src/pipeline-preview.test.ts',
  'libs/core/trust-engine.test.ts',
].sort((a, b) => a.localeCompare(b));

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

describe('Core fs exception boundary', () => {
  it('keeps remaining direct fs imports in libs/core confined to the declared exception set', () => {
    const codeFiles = getAllFiles(path.join(rootDir, 'libs/core')).filter((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath));
    const directFsImports = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.endsWith('.d.ts'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return /from\s+['"](?:node:)?fs['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/.test(content);
      })
      .sort((a, b) => a.localeCompare(b));

    expect(directFsImports).toEqual(allowedCoreFsImports);
  });
});
