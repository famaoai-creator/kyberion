// PA-02: fake browser audio APIs for the `ui:voice-input` tests —
// getUserMedia (optionally held pending / denied), AudioContext + AnalyserNode
// (amplitude is settable), MediaRecorder, SpeechRecognition, rAF and interval
// timers driven by a manual clock. `live()` reports anything still holding the
// microphone, so tests can assert "no leaks".

export class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

export class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  get stopped(): boolean {
    return this.tracks.every((track) => track.stopped);
  }
}

type Handler = ((event?: unknown) => void) | null;

export interface VoiceFakeOptions {
  /** getUserMedia rejects with an error of this name (e.g. NotAllowedError). */
  deny?: string;
  /** getUserMedia promises stay pending until `resolveMedia()`. */
  holdMedia?: boolean;
  noMedia?: boolean;
  noRecognition?: boolean;
  noRecorder?: boolean;
  noAudioContext?: boolean;
  /** MediaRecorder.isTypeSupported answers true only for these. */
  recorderTypes?: string[];
}

export function createVoiceFakes(options: VoiceFakeOptions = {}) {
  let clock = 0;
  let amplitude = 0;
  const streams: FakeStream[] = [];
  const contexts: FakeAudioContext[] = [];
  const recognitions: FakeRecognition[] = [];
  const recorders: FakeRecorder[] = [];
  const pending: Array<{ resolve: (s: FakeStream) => void; reject: (e: unknown) => void }> = [];
  const frames = new Map<number, (t: number) => void>();
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
  let nextHandle = 1;
  let mediaCalls = 0;

  class FakeAnalyser {
    fftSize = 2048;
    getByteTimeDomainData(buffer: Uint8Array): void {
      const amp = Math.round(amplitude * 127);
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 ? 128 + amp : 128 - amp;
    }
  }

  class FakeAudioContext {
    closed = false;
    constructor() {
      contexts.push(this);
    }
    createMediaStreamSource(stream: FakeStream) {
      return { stream, connect: () => undefined };
    }
    createAnalyser() {
      return new FakeAnalyser();
    }
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }

  class FakeRecognition {
    lang = '';
    interimResults = false;
    continuous = false;
    maxAlternatives = 0;
    started = false;
    stopped = false;
    aborted = false;
    onstart: Handler = null;
    onresult: Handler = null;
    onerror: Handler = null;
    onend: Handler = null;
    constructor() {
      recognitions.push(this);
    }
    start(): void {
      this.started = true;
    }
    stop(): void {
      this.stopped = true;
    }
    abort(): void {
      this.aborted = true;
    }
    // -- test drivers
    fireStart(): void {
      this.onstart?.();
    }
    /** `[text, isFinal][]` as one result event starting at `resultIndex`. */
    fireResult(results: Array<[string, boolean]>, resultIndex = 0): void {
      const list = results.map(([transcript, isFinal]) => {
        const alt = [{ transcript }] as unknown as { isFinal: boolean };
        alt.isFinal = isFinal;
        return alt;
      });
      this.onresult?.({ resultIndex, results: list });
    }
    fireError(error: string): void {
      this.onerror?.({ error });
    }
    fireEnd(): void {
      this.onend?.();
    }
  }

  class FakeRecorder {
    static isTypeSupported(type: string): boolean {
      return (options.recorderTypes ?? ['audio/webm']).includes(type);
    }
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    timeslice: number | undefined;
    stopCalls = 0;
    ondataavailable: Handler = null;
    onstop: Handler = null;
    onerror: Handler = null;
    constructor(
      readonly stream: FakeStream,
      init?: { mimeType?: string }
    ) {
      this.mimeType = init?.mimeType ?? '';
      recorders.push(this);
    }
    start(timeslice?: number): void {
      this.state = 'recording';
      this.timeslice = timeslice;
    }
    stop(): void {
      this.stopCalls += 1;
      this.state = 'inactive';
    }
    // -- test drivers
    emit(text: string): void {
      this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType || 'audio/webm' }) });
    }
    finish(): void {
      this.onstop?.();
    }
  }

  const getUserMedia = (constraints: unknown) => {
    mediaCalls += 1;
    void constraints;
    if (options.deny) {
      const error = Object.assign(new Error(options.deny), { name: options.deny });
      return Promise.reject(error);
    }
    if (options.holdMedia) {
      return new Promise<FakeStream>((resolve, reject) => pending.push({ resolve, reject }));
    }
    const stream = new FakeStream();
    streams.push(stream);
    return Promise.resolve(stream);
  };

  const win: Record<string, unknown> = {
    navigator: options.noMedia ? {} : { mediaDevices: { getUserMedia } },
    performance: { now: () => clock },
    requestAnimationFrame: (fn: (t: number) => void) => {
      const handle = nextHandle++;
      frames.set(handle, fn);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      frames.delete(handle);
    },
    setInterval: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      intervals.set(handle, { fn, ms, next: clock + ms });
      return handle;
    },
    clearInterval: (handle: number) => {
      intervals.delete(handle);
    },
    File,
  };
  if (!options.noAudioContext) win.AudioContext = FakeAudioContext;
  if (!options.noRecognition) win.webkitSpeechRecognition = FakeRecognition;
  if (!options.noRecorder) win.MediaRecorder = FakeRecorder;

  return {
    win,
    streams,
    contexts,
    recognitions,
    recorders,
    get mediaCalls() {
      return mediaCalls;
    },
    setAmplitude(value: number) {
      amplitude = value;
    },
    /** Run every queued animation frame once (each may queue the next). */
    frame(): void {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, fn] of due) fn(clock);
    },
    /** Advance the clock, firing intervals in order. */
    advance(ms: number): void {
      const target = clock + ms;
      for (;;) {
        let soonest: [number, { fn: () => void; ms: number; next: number }] | null = null;
        for (const entry of intervals) {
          if (entry[1].next <= target && (!soonest || entry[1].next < soonest[1].next))
            soonest = entry;
        }
        if (!soonest) break;
        clock = soonest[1].next;
        soonest[1].next += soonest[1].ms;
        soonest[1].fn();
      }
      clock = target;
    },
    /** Resolve the oldest held getUserMedia request with a fresh stream. */
    resolveMedia(): FakeStream {
      const next = pending.shift();
      if (!next) throw new Error('no pending getUserMedia');
      const stream = new FakeStream();
      streams.push(stream);
      next.resolve(stream);
      return stream;
    },
    /** Everything still holding the microphone / a loop. */
    live() {
      return {
        streams: streams.filter((s) => !s.stopped).length,
        contexts: contexts.filter((c) => !c.closed).length,
        recognitions: recognitions.filter((r) => r.started && !r.aborted && !r.stopped).length,
        recorders: recorders.filter((r) => r.state !== 'inactive').length,
        frames: frames.size,
        intervals: intervals.size,
      };
    },
  };
}

export const NO_LEAKS = {
  streams: 0,
  contexts: 0,
  recognitions: 0,
  recorders: 0,
  frames: 0,
  intervals: 0,
};

/** Let pending promise continuations run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
