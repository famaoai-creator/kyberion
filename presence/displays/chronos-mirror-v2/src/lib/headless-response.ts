import {
  buildChronosHeadlessManifest,
  createHeadlessEnvelope,
  type HeadlessApiManifest,
} from '@agent/core/headless-surface-contract';
import type { ViewerContext } from './viewer-context';
import { viewerErrorResponse } from './viewer-context';
import { headlessViewerScope, HeadlessQueryError } from './headless-projections';

export function headlessManifest(): HeadlessApiManifest {
  return buildChronosHeadlessManifest();
}

export function headlessManifestForViewer(viewer: ViewerContext): HeadlessApiManifest {
  const manifest = headlessManifest();
  return {
    ...manifest,
    operations: manifest.operations.filter(
      (operation) => viewer.role === 'localadmin' || operation.required_role === 'readonly'
    ),
  };
}

export function headlessEnvelope<T>(
  resource: string,
  data: T,
  viewer: ViewerContext,
  manifest = headlessManifest()
) {
  return createHeadlessEnvelope({
    resource,
    data,
    scope: headlessViewerScope(viewer),
    manifest,
  });
}

export function headlessErrorResponse(error: unknown, statusOverride?: number) {
  return viewerErrorResponse(
    error,
    statusOverride ?? (error instanceof HeadlessQueryError ? 400 : undefined)
  );
}

export function parseHeadlessLimit(
  rawValue: string | null,
  defaultValue: number,
  maximum: number
): number {
  if (rawValue === null || rawValue.trim() === '') return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new HeadlessQueryError(`invalid limit: expected an integer from 1 to ${maximum}`);
  }
  return value;
}
