import { getVoiceRuntimePolicy, type VoiceRuntimePolicy } from './voice-runtime-policy.js';

export type VoiceJobStatus =
  | 'queued'
  | 'loading_profile'
  | 'loading_model'
  | 'generating'
  | 'postprocessing'
  | 'persisting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VoiceProgressPacket {
  kind: 'voice_progress_packet';
  job_id: string;
  status: VoiceJobStatus;
  progress: {
    current: number;
    total: number;
    percent: number;
    unit: 'bytes' | 'chunks' | 'steps' | 'percent';
  };
  message?: string;
  artifact_refs?: string[];
  updated_at: string;
}

export interface VoiceGenerationJobApi {
  report(update: Partial<Omit<VoiceProgressPacket, 'kind' | 'job_id' | 'updated_at'>>): VoiceProgressPacket;
  isCancelled(): boolean;
}

export interface VoiceGenerationJobSpec {
  jobId: string;
  run(api: VoiceGenerationJobApi): Promise<{ artifactRefs?: string[] } | void>;
}

type Listener = (packet: VoiceProgressPacket) => void;

interface EnqueuedJob {
  spec: VoiceGenerationJobSpec;
  cancelled: boolean;
}

interface RunningJob {
  spec: VoiceGenerationJobSpec;
  cancelled: boolean;
  startedAt: number;
}

export class VoiceGenerationRuntime {
  private readonly queue: EnqueuedJob[] = [];
  private readonly packets = new Map<string, VoiceProgressPacket>();
  private readonly listeners = new Set<Listener>();
  private readonly running = new Map<string, RunningJob>();
  private readonly lastNotifiedAt = new Map<string, number>();
  private readonly lastNotifiedPercent = new Map<string, number>();
  private pumping = false;

  constructor(private readonly policy: VoiceRuntimePolicy = getVoiceRuntimePolicy()) {}

  public enqueue(spec: VoiceGenerationJobSpec): VoiceProgressPacket {
    if (this.packets.has(spec.jobId)) {
      throw new Error(`voice job already exists: ${spec.jobId}`);
    }
    const packet = this.buildPacket(spec.jobId, 'queued', {
      progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
      message: 'queued',
    });
    this.packets.set(spec.jobId, packet);
    this.queue.push({ spec, cancelled: false });
    this.notify(packet, true);
    void this.pump();
    return packet;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getPacket(jobId: string): VoiceProgressPacket | null {
    return this.packets.get(jobId) || null;
  }

  public listActivePackets(): VoiceProgressPacket[] {
    return Array.from(this.packets.values()).filter((packet) => (
      packet.status !== 'completed' && packet.status !== 'failed' && packet.status !== 'cancelled'
    ));
  }

  public cancel(jobId: string): 'queued' | 'running' | null {
    const queuedJob = this.queue.find((entry) => entry.spec.jobId === jobId);
    if (queuedJob) {
      queuedJob.cancelled = true;
      this.packets.set(jobId, this.buildPacket(jobId, 'cancelled', {
        progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
        message: 'cancelled before execution',
      }));
      this.notify(this.packets.get(jobId) as VoiceProgressPacket, true);
      return 'queued';
    }

    if (this.policy.queue.cancellation === 'queued_only') return null;

    const runningJob = this.running.get(jobId);
    if (!runningJob) return null;
    runningJob.cancelled = true;
    this.packets.set(jobId, this.buildPacket(jobId, 'cancelled', {
      progress: this.packets.get(jobId)?.progress || { current: 0, total: 1, percent: 0, unit: 'steps' },
      message: 'cancellation requested',
    }));
    this.notify(this.packets.get(jobId) as VoiceProgressPacket, true);
    return 'running';
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.policy.queue.concurrency) {
        const next = this.dequeueNextRunnable();
        if (!next) break;
        const runningJob: RunningJob = {
          spec: next.spec,
          cancelled: false,
          startedAt: Date.now(),
        };
        this.running.set(next.spec.jobId, runningJob);
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
    const api: VoiceGenerationJobApi = {
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
          message: error?.message || 'voice job failed',
        });
        this.packets.set(jobId, packet);
        this.notify(packet, true);
      }
    } finally {
      this.running.delete(jobId);
      void this.pump();
    }
  }

  private report(jobId: string, update: Partial<Omit<VoiceProgressPacket, 'kind' | 'job_id' | 'updated_at'>>): VoiceProgressPacket {
    const current = this.packets.get(jobId) || this.buildPacket(jobId, 'queued', {
      progress: { current: 0, total: 1, percent: 0, unit: 'steps' },
    });
    if (current.status === 'cancelled' && update.status !== 'cancelled') return current;

    const packet = this.buildPacket(jobId, update.status || current.status, {
      progress: update.progress || current.progress,
      message: update.message === undefined ? current.message : update.message,
      artifact_refs: update.artifact_refs === undefined ? current.artifact_refs : update.artifact_refs,
    });
    this.packets.set(jobId, packet);
    this.notify(packet, false);
    return packet;
  }

  private buildPacket(
    jobId: string,
    status: VoiceJobStatus,
    data: Pick<VoiceProgressPacket, 'progress'> & Partial<Pick<VoiceProgressPacket, 'message' | 'artifact_refs'>>,
  ): VoiceProgressPacket {
    return {
      kind: 'voice_progress_packet',
      job_id: jobId,
      status,
      progress: {
        ...data.progress,
        percent: clampPercent(data.progress.percent),
      },
      message: data.message,
      artifact_refs: data.artifact_refs,
      updated_at: new Date().toISOString(),
    };
  }

  private notify(packet: VoiceProgressPacket, force: boolean): void {
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
