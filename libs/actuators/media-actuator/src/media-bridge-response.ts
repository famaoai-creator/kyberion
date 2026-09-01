function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface MediaBridgeResponse extends Record<string, unknown> {
  ok: boolean;
  error?: string;
  code?: string;
}

export function parseMediaBridgeResponse(value: unknown): MediaBridgeResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('invalid_media_bridge_response');
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    throw new Error('invalid_media_bridge_response_error');
  }
  if (value.code !== undefined && typeof value.code !== 'string') {
    throw new Error('invalid_media_bridge_response_code');
  }
  return value as MediaBridgeResponse;
}

export function parsePdfSplitBridgeResponse(value: unknown): MediaBridgeResponse {
  const response = parseMediaBridgeResponse(value);
  if (!response.ok) return response;
  if (
    typeof response.count !== 'number' ||
    !Number.isSafeInteger(response.count) ||
    response.count <= 0 ||
    typeof response.out_dir !== 'string' ||
    !response.out_dir.trim() ||
    !Array.isArray(response.pages) ||
    response.pages.length !== response.count ||
    !response.pages.every((page) => typeof page === 'string' && page.trim())
  ) {
    throw new Error('invalid_pdf_split_bridge_response');
  }
  return response;
}
