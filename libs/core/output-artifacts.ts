import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';

export const DEFAULT_INLINE_OUTPUT_CHARS = 16_000;

export interface OutputArtifactReference {
  artifact_path: string;
  preview: string;
  truncated: true;
  chars: number;
  bytes: number;
  media_type: 'text/plain' | 'application/json';
}

export interface OutputArtifactOptions {
  maxInlineChars?: number;
  stepOp?: string;
  stepNumber?: number;
  missionId?: string;
  recordArtifact?: (path: string, description: string) => void;
}

function slug(value: string, fallback: string): string {
  return (
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}

function previewText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function serializeOutput(value: unknown): {
  text: string;
  mediaType: OutputArtifactReference['media_type'];
} {
  if (typeof value === 'string') return { text: value, mediaType: 'text/plain' };
  try {
    return { text: JSON.stringify(value, null, 2), mediaType: 'application/json' };
  } catch {
    return { text: String(value), mediaType: 'text/plain' };
  }
}

/**
 * Persist an oversized step result under the governed temporary area and
 * return a bounded reference suitable for carrying through later steps.
 */
export function offloadLargeOutput(
  value: unknown,
  options: OutputArtifactOptions = {}
): OutputArtifactReference | null {
  const configuredLimit = Number(options.maxInlineChars);
  const maxInlineChars =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.max(256, configuredLimit)
      : DEFAULT_INLINE_OUTPUT_CHARS;
  const serialized = serializeOutput(value);
  if (serialized.text.length <= maxInlineChars) return null;

  const mission = slug(options.missionId || 'shared', 'shared');
  const step = slug(options.stepOp || 'step', 'step');
  const stepNumber = Number.isFinite(options.stepNumber) ? String(options.stepNumber) : 'n';
  const id = crypto.randomUUID();
  const relativePath = path.join('tool-output', mission, `${stepNumber}-${step}-${id}.log`);
  const absolutePath = pathResolver.sharedTmp(relativePath);
  safeMkdir(path.dirname(absolutePath), { recursive: true });
  safeWriteFile(absolutePath, serialized.text, { mkdir: true, encoding: 'utf8' });

  const portablePath = pathResolver.toRepoRelative(absolutePath);
  const reference: OutputArtifactReference = {
    artifact_path: portablePath,
    preview: previewText(serialized.text, maxInlineChars),
    truncated: true,
    chars: serialized.text.length,
    bytes: Buffer.byteLength(serialized.text, 'utf8'),
    media_type: serialized.mediaType,
  };
  options.recordArtifact?.(portablePath, `Oversized output from ${options.stepOp || 'step'}`);
  return reference;
}

/**
 * Compact only the current step's exported channel, preserving unrelated
 * input/context values. The returned object is safe to pass to the next ADF
 * step without embedding the full tool result in the context.
 */
export function compactStepOutputContext(
  context: Record<string, unknown>,
  outputKeys: string[],
  options: OutputArtifactOptions = {}
): Record<string, unknown> {
  const next = { ...context };
  for (const key of Array.from(new Set(outputKeys)).filter(Boolean)) {
    if (!(key in next)) continue;
    const value = next[key];
    if (
      value &&
      typeof value === 'object' &&
      'artifact_path' in (value as Record<string, unknown>)
    ) {
      continue;
    }
    const reference = offloadLargeOutput(value, options);
    if (reference) next[key] = reference;
  }
  return next;
}
