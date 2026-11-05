import type {
  VideoGenerationJsonRecord,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoGenerationSubmission,
} from '../types.js';
import {
  asRecord,
  baseUrl,
  downloadUrl,
  jsonRequest,
  outputUrl,
  requireEnv,
  statusFrom,
} from '../provider-support.js';

export class MiniMaxHailuoProvider implements VideoGenerationProvider {
  readonly provider = 'minimax_hailuo';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();
  private readonly fileByJob = new Map<string, string>();

  private key(): string {
    return requireEnv('KYBERION_MINIMAX_VIDEO_API_KEY', 'MINIMAX_API_KEY');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_MINIMAX_VIDEO_URL', 'https://api.minimaxi.com/v1');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key()}`, 'Content-Type': 'application/json' };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const payload: VideoGenerationJsonRecord = {
      model: request.model,
      prompt: request.prompt,
      ...(request.duration_seconds ? { duration: request.duration_seconds } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.first_frame_image ? { first_frame_image: request.first_frame_image } : {}),
      ...(request.last_frame_image ? { last_frame_image: request.last_frame_image } : {}),
    };
    const response = await jsonRequest(`${this.baseUrl()}/video_generation`, 'POST', {
      headers: this.headers(),
      data: payload,
      request,
    });
    const providerJobId = String(response.task_id || '');
    if (!providerJobId) throw new Error('MiniMax submission did not return a task id');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const response = await jsonRequest(`${this.baseUrl()}/query/video_generation`, 'GET', {
      headers: this.headers(),
      params: { task_id: providerJobId },
      request: request || this.requestByJob.get(providerJobId),
    });
    const fileId = typeof response.file_id === 'string' ? response.file_id : undefined;
    if (fileId) this.fileByJob.set(providerJobId, fileId);
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status: statusFrom(response.status),
      file_id: fileId,
      error:
        response.status === 'Fail' ? JSON.stringify(response.base_resp || response) : undefined,
      metadata: { video_width: response.video_width, video_height: response.video_height },
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    const fileId = status.file_id || this.fileByJob.get(status.provider_job_id);
    if (!fileId) throw new Error('MiniMax completed without a file id');
    const response = await jsonRequest(`${this.baseUrl()}/files/retrieve`, 'GET', {
      headers: this.headers(),
      params: { file_id: fileId },
      request: request || this.requestByJob.get(status.provider_job_id),
    });
    const url = outputUrl(asRecord(response.file));
    if (!url) throw new Error('MiniMax file retrieval did not return a download URL');
    return downloadUrl(url, this.requestByJob.get(status.provider_job_id));
  }
}
