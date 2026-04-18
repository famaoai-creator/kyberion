import { getVideoRenderRuntimePolicy } from './video-render-runtime-policy.js';
import type { VideoRenderJobStatus, VideoRenderProgressPacket, VideoRenderRuntimePolicy } from './video-composition-contract.js';

export interface VideoRenderJobApi {
  report(update: Partial<Omit<VideoRenderProgressPacket, 'kind' | 'job_id' | 'updated_at'>>): VideoRenderProgressPacket;
  isCancelled(): boolean;
}

export interface VideoRenderJobSpec {
  jobId: string;
  run(api: VideoRenderJobApi): Promise<{ artifactRefs?: string[] } | void>;
}

type Listener = (packet: VideoRenderProgressPacket) => void;

interface EnqueuedJob {
  spec: VideoRenderJobSpec;
  cancelled: boolean;
}

interface RunningJob {
  spec: VideoRenderJobSpec;
  cancelled: boolean;
}

export interface VideoRenderQueueSnapshot {
  queued_total: number;
  running: number;
  concurrency: number;
  jobs: Array<{ job_id: string; position: number; queued_ahead: number }>;
}

export class VideoRenderRuntime {
  private readonly queue: EnqueuedJob[] = [];
  private readonly packets = new Map<string, VideoRenderProgressPacket>();
  private readonly listeners = new Set<Listener>();
  private readonly running = new Map<string, RunningJob>();
  private readonly lastNotifiedAt = new Map<string, number>();
  private readonly lastNotifiedPercent = new Map<string, number>();
  private pumping = false;

  constructor(private readonly policy: VideoRenderRuntimePolicy = getVideoRenderRuntimePolicy()) {}

  public enqueue(spec: VideoRenderJobSpec): VideoRenderProgressPacket {
    if (this.packets.has(spec.jobId)) {
      throw new Error(`video render job already exists: ${spec.jobId}`);
    }
    this.queue.push({ spec, cancelled: false });
    const packet = this.buildPacket(spec.jobId, 'queued', {
      progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
      message: 'queued',
      queue: this.buildQueueData(spec.jobId),
    });
    this.packets.set(spec.jobId, packet);
    this.notify(packet, true);
    this.refreshQueuedPackets(true);
    void this.pump();
    return packet;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getPacket(jobId: string): VideoRenderProgressPacket | null {
    return this.packets.get(jobId) || null;
  }

  public cancel(jobId: string): 'queued' | 'running' | null {
    const queuedIndex = this.queue.findIndex((entry) => entry.spec.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      const packet = this.buildPacket(jobId, 'cancelled', {
        progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
        message: 'cancelled before execution',
      });
      this.packets.set(jobId, packet);
      this.notify(packet, true);
      this.refreshQueuedPackets(true);
      return 'queued';
    }

    if (this.policy.queue.cancellation === 'queued_only') return null;

    const runningJob = this.running.get(jobId);
    if (!runningJob) return null;
    runningJob.cancelled = true;
    const packet = this.buildPacket(jobId, 'cancelled', {
      progress: this.packets.get(jobId)?.progress || { current: 0, total: 1, percent: 0, unit: 'steps' },
      message: 'cancellation requested',
    });
    this.packets.set(jobId, packet);
    this.notify(packet, true);
    this.refreshQueuedPackets(true);
    return 'running';
  }

  public getQueueSnapshot(): VideoRenderQueueSnapshot {
    const activeQueue = this.queue.filter((entry) => !entry.cancelled);
    return {
      queued_total: activeQueue.length,
      running: this.running.size,
      concurrency: this.policy.queue.concurrency,
      jobs: activeQueue.map((entry, index) => ({
        job_id: entry.spec.jobId,
        position: index + 1,
        queued_ahead: index,
      })),
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.policy.queue.concurrency) {
        const next = this.dequeueNextRunnable();
        if (!next) break;
        const runningJob: RunningJob = { spec: next.spec, cancelled: false };
        this.running.set(next.spec.jobId, runningJob);
        this.refreshQueuedPackets(true);
        void this.execute(runningJob);
      }
    } finally {
      this.pumping = false;
    }
  }

  private dequeueNextRunnable(): EnqueuedJob | null {
    while (this.queue.length > 0) {
      const next = this.queue.shift() as EnqueuedJob;
      if (!next.cancelled) return next;
    }
    return null;
  }

  private async execute(job: RunningJob): Promise<void> {
    const jobId = job.spec.jobId;
    const api: VideoRenderJobApi = {
      report: (update) => this.report(jobId, update),
      isCancelled: () => job.cancelled,
    };

    try {
      const result = await job.spec.run(api);
      if (!job.cancelled) {
        const artifactRefs = result && typeof result === 'object' && 'artifactRefs' in result
          ? result.artifactRefs
          : undefined;
        const packet = this.buildPacket(jobId, 'completed', {
          progress: { current: 1, total: 1, percent: 100, unit: 'steps' },
          message: 'completed',
          artifact_refs: artifactRefs,
        });
        this.packets.set(jobId, packet);
        this.notify(packet, true);
      }
    } catch (error: any) {
      if (!job.cancelled) {
        const packet = this.buildPacket(jobId, 'failed', {
          progress: this.packets.get(jobId)?.progress || { current: 0, total: 1, percent: 0, unit: 'steps' },
          message: error?.message || 'video render job failed',
        });
        this.packets.set(jobId, packet);
        this.notify(packet, true);
      }
    } finally {
      this.running.delete(jobId);
      this.refreshQueuedPackets(true);
      void this.pump();
    }
  }

  private report(jobId: string, update: Partial<Omit<VideoRenderProgressPacket, 'kind' | 'job_id' | 'updated_at'>>): VideoRenderProgressPacket {
    const current = this.packets.get(jobId) || this.buildPacket(jobId, 'queued', {
      progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
    });
    if (current.status === 'cancelled' && update.status !== 'cancelled') return current;

    const packet = this.buildPacket(jobId, update.status || current.status, {
      progress: update.progress || current.progress,
      message: update.message === undefined ? current.message : update.message,
      artifact_refs: update.artifact_refs === undefined ? current.artifact_refs : update.artifact_refs,
      queue: update.queue === undefined ? current.queue : update.queue,
    });
    this.packets.set(jobId, packet);
    this.notify(packet, false);
    return packet;
  }

  private buildPacket(
    jobId: string,
    status: VideoRenderJobStatus,
    data: Pick<VideoRenderProgressPacket, 'progress'> & Partial<Pick<VideoRenderProgressPacket, 'message' | 'artifact_refs' | 'queue'>>,
  ): VideoRenderProgressPacket {
    return {
      kind: 'video_render_progress_packet',
      job_id: jobId,
      status,
      progress: {
        ...data.progress,
        percent: clampPercent(data.progress.percent),
      },
      message: data.message,
      artifact_refs: data.artifact_refs,
      queue: data.queue,
      updated_at: new Date().toISOString(),
    };
  }

  private buildQueueData(jobId: string): VideoRenderProgressPacket['queue'] | undefined {
    const snapshot = this.getQueueSnapshot();
    const index = snapshot.jobs.findIndex((entry) => entry.job_id === jobId);
    if (index < 0) return undefined;
    return {
      position: snapshot.jobs[index].position,
      queued_ahead: snapshot.jobs[index].queued_ahead,
      queued_total: snapshot.queued_total,
      running: snapshot.running,
      concurrency: snapshot.concurrency,
    };
  }

  private refreshQueuedPackets(force: boolean): void {
    const snapshot = this.getQueueSnapshot();
    for (const job of snapshot.jobs) {
      const current = this.packets.get(job.job_id);
      if (!current || current.status !== 'queued') continue;
      const packet = this.buildPacket(job.job_id, 'queued', {
        progress: current.progress,
        message: current.message,
        artifact_refs: current.artifact_refs,
        queue: {
          position: job.position,
          queued_ahead: job.queued_ahead,
          queued_total: snapshot.queued_total,
          running: snapshot.running,
          concurrency: snapshot.concurrency,
        },
      });
      this.packets.set(job.job_id, packet);
      this.notify(packet, force);
    }
  }

  private notify(packet: VideoRenderProgressPacket, force: boolean): void {
    const now = Date.now();
    const lastTime = this.lastNotifiedAt.get(packet.job_id) || 0;
    const lastPercent = this.lastNotifiedPercent.get(packet.job_id) || -100;
    const timeDelta = now - lastTime;
    const percentDelta = Math.abs(packet.progress.percent - lastPercent);
    const shouldNotify = force
      || timeDelta >= this.policy.progress.throttle_ms
      || percentDelta >= this.policy.progress.min_percent_delta;
    if (!shouldNotify) return;
    this.lastNotifiedAt.set(packet.job_id, now);
    this.lastNotifiedPercent.set(packet.job_id, packet.progress.percent);
    for (const listener of this.listeners) listener(packet);
  }
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}
