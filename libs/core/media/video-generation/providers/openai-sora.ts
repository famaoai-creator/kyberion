import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoGenerationSubmission,
} from '../types.js';
import { baseUrl, downloadUrl, jsonRequest, requireEnv, statusFrom } from '../provider-support.js';

export class OpenAiSoraProvider implements VideoGenerationProvider {
  readonly provider = 'openai_sora';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private key(): string {
    return requireEnv('KYBERION_OPENAI_VIDEO_API_KEY', 'OPENAI_API_KEY');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_OPENAI_VIDEO_URL', 'https://api.openai.com/v1');
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const form = new FormData();
    form.append('model', request.model);
    form.append('prompt', request.prompt);
    if (request.duration_seconds) form.append('seconds', String(request.duration_seconds));
    if (request.resolution) form.append('size', request.resolution);
    if (request.first_frame_image?.startsWith('data:')) {
      const match = request.first_frame_image.match(/^data:([^;]+);base64,(.+)$/u);
      if (match) {
        form.append(
          'input_reference',
          new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }),
          'reference-image'
        );
      }
    }
    const response = await jsonRequest(`${this.baseUrl()}/videos`, 'POST', {
      headers: { Authorization: `Bearer ${this.key()}` },
      data: form,
      request,
    });
    const providerJobId = String(response.id || '');
    if (!providerJobId) throw new Error('OpenAI Sora submission did not return a video id');
    this.requestByJob.set(providerJobId, request);
    return {
      provider_job_id: providerJobId,
      status: statusFrom(response.status),
      provider: this.provider,
    };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const response = await jsonRequest(
      `${this.baseUrl()}/videos/${encodeURIComponent(providerJobId)}`,
      'GET',
      {
        headers: { Authorization: `Bearer ${this.key()}` },
        request: request || this.requestByJob.get(providerJobId),
      }
    );
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: statusFrom(response.status),
      error: typeof response.error === 'string' ? response.error : undefined,
      metadata: response,
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    return downloadUrl(
      `${this.baseUrl()}/videos/${encodeURIComponent(status.provider_job_id)}/content`,
      request || this.requestByJob.get(status.provider_job_id),
      {
        Authorization: `Bearer ${this.key()}`,
      }
    );
  }
}
