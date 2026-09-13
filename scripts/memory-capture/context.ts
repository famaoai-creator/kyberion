import {
  createLocalPadContext,
  localPadHandoffPath,
  localPadReceiptPath,
  localPadSessionDir,
  type LocalPadContext,
  type PadTier,
} from '../lib/local-artifact-pad.js';

export type MemoryCaptureContext = LocalPadContext;

export function createMemoryCaptureContext(input: {
  artifact_ref: string;
  viewer_principal: string;
  tier: PadTier;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): MemoryCaptureContext {
  return createLocalPadContext({
    serviceId: 'memory-capture',
    sessionPrefix: 'mc',
    ...input,
  });
}

export function memoryCaptureReceiptLogicalPath(context: MemoryCaptureContext): string {
  return localPadReceiptPath('memory-capture', context);
}

export function memoryCaptureHandoffLogicalPath(outDir: string): string {
  return localPadHandoffPath(outDir);
}

export function memoryCaptureSessionDir(outDir: string, sessionId: string): string {
  return localPadSessionDir(outDir, sessionId);
}
