import {
  createLocalPadContext,
  localPadHandoffPath,
  localPadReceiptPath,
  localPadSessionDir,
  type LocalPadContext,
  type PadTier,
} from '../lib/local-artifact-pad.js';

export type ClipboardInboxContext = LocalPadContext;

export function createClipboardInboxContext(input: {
  artifact_ref: string;
  viewer_principal: string;
  tier: PadTier;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): ClipboardInboxContext {
  return createLocalPadContext({
    serviceId: 'clipboard-inbox',
    sessionPrefix: 'ci',
    ...input,
  });
}

export function clipboardInboxReceiptLogicalPath(context: ClipboardInboxContext): string {
  return localPadReceiptPath('clipboard-inbox', context);
}

export function clipboardInboxHandoffLogicalPath(outDir: string): string {
  return localPadHandoffPath(outDir);
}

export function clipboardInboxSessionDir(outDir: string, sessionId: string): string {
  return localPadSessionDir(outDir, sessionId);
}
