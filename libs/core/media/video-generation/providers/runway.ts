import type {
  JsonRecord,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoGenerationSubmission,
} from '../types.js';
import {
  baseUrl,
  downloadUrl,
  jsonRequest,
  outputUrl,
  requireEnv,
  runwayRatio,
  statusFrom,
} from '../provider-support.js';

export class RunwayProvider implements VideoGenerationProvider {
  readonly provider = 'runway';
  private readonly requestByJob = new Map<string, VideoGenerationRequest>();

  private key(): string {
    return requireEnv('KYBERION_RUNWAY_API_KEY', 'RUNWAYML_API_SECRET');
  }

  private baseUrl(): string {
    return baseUrl('KYBERION_RUNWAY_VIDEO_URL', 'https://api.dev.runwayml.com/v1');
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key()}`,
      'X-Runway-Version': '2024-11-06',
      'Content-Type': 'application/json',
    };
  }

  async submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission> {
    const promptImage =
      request.first_frame_image && request.last_frame_image
        ? [
            { uri: request.first_frame_image, position: 'first' },
            { uri: request.last_frame_image, position: 'last' },
          ]
        : request.first_frame_image;
    const payload: JsonRecord = {
      model: request.model,
      promptText: request.prompt,
      ...(promptImage ? { promptImage } : {}),
      ...(runwayRatio(request) ? { ratio: runwayRatio(request) } : {}),
      ...(request.duration_seconds ? { duration: request.duration_seconds } : {}),
      ...(typeof request.generate_audio === 'boolean'
        ? { generateAudio: request.generate_audio }
        : {}),
    };
    const task = await jsonRequest(`${this.baseUrl()}/image_to_video`, 'POST', {
      headers: this.headers(),
      data: payload,
      request,
    });
    const providerJobId = String(task.id || task.task_id || '');
    if (!providerJobId) throw new Error('Runway submission did not return a task id');
    this.requestByJob.set(providerJobId, request);
    return { provider_job_id: providerJobId, status: 'submitted', provider: this.provider };
  }

  async status(
    providerJobId: string,
    request?: VideoGenerationRequest
  ): Promise<VideoGenerationStatus> {
    const task = await jsonRequest(
      `${this.baseUrl()}/tasks/${encodeURIComponent(providerJobId)}`,
      'GET',
      {
        headers: this.headers(),
        request: request || this.requestByJob.get(providerJobId),
      }
    );
    const status = statusFrom(task.status);
    return {
      provider_job_id: providerJobId,
      provider: this.provider,
      status,
      output_url: outputUrl(task),
      error: typeof task.failure === 'string' ? task.failure : undefined,
      metadata: { failure_code: task.failureCode },
    };
  }

  async download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer> {
    if (!status.output_url) throw new Error('Runway completed without an output URL');
    return downloadUrl(status.output_url, request || this.requestByJob.get(status.provider_job_id));
  }
}
