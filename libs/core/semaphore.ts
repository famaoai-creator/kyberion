export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent = 1) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Semaphore maxConcurrent must be a positive integer');
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

const parsedLimit = Number.parseInt(process.env.KYBERION_LLM_CONCURRENCY ?? '1', 10);
export const llmSemaphore = new Semaphore(Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1);
