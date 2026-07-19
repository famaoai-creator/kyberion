import type { GeneratedArtifact, GenerationModality } from './media-generation-helpers.js';

export type ProviderHistory = Record<string, unknown>;
export type ArtifactPathResolver = (item: Record<string, unknown>) => string;

export interface GenerationHistoryAdapter {
  modality: GenerationModality;
  accepted_formats: readonly string[];
  is_failed(history: unknown): boolean;
  is_complete(history: unknown): boolean;
  extract_artifacts(history: unknown, resolvePath: ArtifactPathResolver): GeneratedArtifact[];
  select_primary(
    artifacts: GeneratedArtifact[],
    requestedFormat?: string
  ): GeneratedArtifact | undefined;
}

const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp'] as const;
const VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'gif'] as const;
const MUSIC_FORMATS = ['mp3', 'wav', 'flac'] as const;
const WORKFLOW_FORMATS = [...IMAGE_FORMATS, ...VIDEO_FORMATS, ...MUSIC_FORMATS] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lowerString(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function historyStatus(history: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(history)?.status);
}

function statusText(history: unknown): string {
  const status = historyStatus(history);
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  return [
    lowerString(status?.status_str),
    lowerString(status?.status),
    ...messages.map((message) => JSON.stringify(message).toLowerCase()),
  ].join(' ');
}

function isFailedHistory(history: unknown): boolean {
  const text = statusText(history);
  return /(failed|failure|error|canceled|cancelled|execution_error)/u.test(text);
}

function hasOutputs(history: unknown): boolean {
  const outputs = asRecord(asRecord(history)?.outputs);
  return Boolean(outputs && Object.keys(outputs).length > 0);
}

function isCompleteHistory(history: unknown): boolean {
  if (isFailedHistory(history)) return true;
  const status = historyStatus(history);
  return status?.completed === true || hasOutputs(history);
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function isOutputItem(value: unknown): value is Record<string, unknown> {
  const item = asRecord(value);
  return Boolean(item && typeof item.filename === 'string' && item.filename.length > 0);
}

function extractComfyArtifacts(
  history: unknown,
  acceptedFormats: readonly string[],
  resolvePath: ArtifactPathResolver
): GeneratedArtifact[] {
  const outputs = asRecord(asRecord(history)?.outputs);
  if (!outputs) return [];

  const artifacts: GeneratedArtifact[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    const output = asRecord(nodeOutput);
    if (!output) continue;
    for (const [kind, values] of Object.entries(output)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!isOutputItem(value)) continue;
        const filename = typeof value.filename === 'string' ? value.filename : '';
        if (!filename) continue;
        const extension = fileExtension(filename);
        if (extension && !acceptedFormats.includes(extension)) continue;
        const artifact: GeneratedArtifact = {
          kind,
          filename,
          type: typeof value.type === 'string' && value.type ? value.type : 'output',
          ...(typeof value.subfolder === 'string' && value.subfolder
            ? { subfolder: value.subfolder }
            : {}),
          path: resolvePath(value),
        };
        artifacts.push(artifact);
      }
    }
  }
  return artifacts;
}

function selectPrimaryArtifact(
  artifacts: GeneratedArtifact[],
  requestedFormat?: string
): GeneratedArtifact | undefined {
  const normalizedFormat = requestedFormat?.toLowerCase().replace(/^\./u, '');
  const available = normalizedFormat
    ? artifacts.filter((artifact) => fileExtension(artifact.filename) === normalizedFormat)
    : artifacts;
  const candidates = available.length > 0 ? available : artifacts;
  return (
    candidates.find((artifact) => artifact.type === 'output') ||
    candidates.find((artifact) => artifact.kind !== 'preview' && artifact.kind !== 'temp') ||
    candidates[0]
  );
}

function createAdapter(
  modality: GenerationModality,
  accepted_formats: readonly string[]
): GenerationHistoryAdapter {
  return {
    modality,
    accepted_formats,
    is_failed: isFailedHistory,
    is_complete: isCompleteHistory,
    extract_artifacts: (history, resolvePath) =>
      extractComfyArtifacts(history, accepted_formats, resolvePath),
    select_primary: (artifacts, requestedFormat) =>
      selectPrimaryArtifact(artifacts, requestedFormat),
  };
}

const ADAPTERS: Record<GenerationModality, GenerationHistoryAdapter> = {
  image: createAdapter('image', IMAGE_FORMATS),
  video: createAdapter('video', VIDEO_FORMATS),
  music: createAdapter('music', MUSIC_FORMATS),
  workflow: createAdapter('workflow', WORKFLOW_FORMATS),
};

export function getGenerationHistoryAdapter(
  modality: GenerationModality = 'workflow'
): GenerationHistoryAdapter {
  return ADAPTERS[modality];
}

export function modalityForGenerationAction(action: string): GenerationModality {
  if (action === 'generate_image') return 'image';
  if (action === 'generate_video') return 'video';
  if (action === 'generate_music') return 'music';
  return 'workflow';
}

export function getGenerationHistoryAdapterForAction(action: string): GenerationHistoryAdapter {
  return getGenerationHistoryAdapter(modalityForGenerationAction(action));
}
