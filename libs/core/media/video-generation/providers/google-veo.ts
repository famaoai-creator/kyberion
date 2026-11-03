import type {
  VideoGenerationJsonRecord,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoGenerationSubmission,
} from '../types.js';
import { asRecord, baseUrl, downloadUrl, jsonRequest, requireEnv } from '../provider-support.js';

export class GoogleVeoProvider implements VideoGenerationProvider {
  readonly provider = 'google_veo';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private apiKey(): string {
    return requireEnv(
      'KYBERION_GEMINI_VIDEO_API_KEY',
      'KYBERION_GEMINI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY'
    );
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_GEMINI_VIDEO_URL', 'https://generativelanguage.googleapis.com/v1beta');
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const key = this.apiKey();
    const instance: VideoGenerationJsonRecord = { prompt: request.prompt };
    if (request.first_frame_image?.startsWith('data:')) {
      const match = request.first_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) instance.image = { inlineData: { mimeType: match[1], data: match[2] } };
    }
    if (request.last_frame_image?.startsWith('data:')) {
      const match = request.last_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) instance.lastFrame = { inlineData: { mimeType: match[1], data: match[2] } };
    }
    const parameters: VideoGenerationJsonRecord = {};
    if (request.aspect_ratio) parameters.aspectRatio = request.aspect_ratio;
    if (request.resolution) parameters.resolution = request.resolution;
    const operation = await jsonRequest(
      `${this.baseUrl()}/models/${encodeURIComponent(request.model)}:predictLongRunning`,
      'POST',
      {
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        data: { instances: [instance], ...(Object.keys(parameters).length ? { parameters } : {}) },
        request,
      }
    );
    const providerJobId = String(operation.name || asRecord(operation.operation).name || '');
    if (!providerJobId) throw new Error('Google Veo submission did not return an operation name');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const requestContext = request || this.requestByJob.get(providerJobId);
    const key = this.apiKey();
    const url = providerJobId.startsWith('http')
      ? providerJobId
      : `${this.baseUrl()}/${providerJobId.replace(/^\//u, '')}`;
    const operation = await jsonRequest(url, 'GET', {
      headers: { 'x-goog-api-key': key },
      request: requestContext,
    });
    const response = asRecord(operation.response);
    const generatedVideoResponse = asRecord(response.generateVideoResponse);
    const generatedSamples = Array.isArray(generatedVideoResponse.generatedSamples)
      ? generatedVideoResponse.generatedSamples
      : [];
    const sample = asRecord(asRecord(generatedSamples[0]).video);
    const status: VideoGenerationStatus = {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: operation.done === true ? (operation.error ? 'failed' : 'succeeded') : 'running',
      output_url: typeof sample.uri === 'string' ? sample.uri : undefined,
      inline_video_base64: typeof sample.videoBytes === 'string' ? sample.videoBytes : undefined,
      error: operation.error ? JSON.stringify(operation.error) : undefined,
    };
    return status;
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    if (status.inline_video_base64) return Buffer.from(status.inline_video_base64, 'base64');
    if (!status.output_url) throw new Error('Google Veo completed without a video URI');
    return downloadUrl(
      status.output_url,
      request || this.requestByJob.get(status.provider_job_id),
      {
        'x-goog-api-key': this.apiKey(),
      }
    );
  }
}
