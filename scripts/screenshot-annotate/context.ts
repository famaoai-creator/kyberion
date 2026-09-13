import {
  createLocalPadContext,
  localPadHandoffPath,
  localPadReceiptPath,
  localPadSessionDir,
  type LocalPadContext,
  type PadTier,
} from '../lib/local-artifact-pad.js';

export type ScreenshotAnnotateContext = LocalPadContext;

export function createScreenshotAnnotateContext(input: {
  artifact_ref: string;
  viewer_principal: string;
  tier: PadTier;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): ScreenshotAnnotateContext {
  return createLocalPadContext({
    serviceId: 'screenshot-annotate',
    sessionPrefix: 'sa',
    ...input,
  });
}

export function screenshotAnnotateReceiptLogicalPath(context: ScreenshotAnnotateContext): string {
  return localPadReceiptPath('screenshot-annotate', context);
}

export function screenshotAnnotateHandoffLogicalPath(outDir: string): string {
  return localPadHandoffPath(outDir);
}

export function screenshotAnnotateSessionDir(outDir: string, sessionId: string): string {
  return localPadSessionDir(outDir, sessionId);
}
