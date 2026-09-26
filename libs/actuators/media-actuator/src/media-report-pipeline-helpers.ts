/**
 * Media report pipeline helpers — factory that wires the summary-report
 * DOCX/PDF protocol builders. The builders live in
 * `media-report-docx-builder.ts` / `media-report-pdf-builder.ts`; shared
 * types and color helpers live in `media-report-shared.ts`.
 */
import { buildReportDocxProtocol } from './media-report-docx-builder.js';
import { buildReportPdfProtocol } from './media-report-pdf-builder.js';
import type {
  MediaReportPipelineDeps,
  MediaReportDocxProtocol,
  MediaReportPdfProtocol,
} from './media-report-shared.js';

export type {
  MediaReportPipelineDeps,
  MediaReportDocxProtocol,
  MediaReportPdfProtocol,
} from './media-report-shared.js';

export function createMediaReportPipelineHelpers(deps: MediaReportPipelineDeps) {
  return {
    buildReportDocxProtocol: (rootDir: string, brief: any): MediaReportDocxProtocol =>
      buildReportDocxProtocol(deps, rootDir, brief),
    buildReportPdfProtocol: (rootDir: string, brief: any): MediaReportPdfProtocol =>
      buildReportPdfProtocol(deps, rootDir, brief),
  };
}
