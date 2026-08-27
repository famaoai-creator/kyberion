#!/usr/bin/env node

/* CE-08: browser-dependent performance evidence. It is intentionally outside
 * the normal validate chain; Chronos schedule/PR jobs invoke it explicitly. */
/* eslint-disable no-restricted-imports -- The perf gate needs a long-lived local Next server; safeExec is synchronous and cannot provide a lifecycle handle. */
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface ChronosPerfSample {
  url: string;
  avg_fps: number;
  js_heap_mib: number | null;
  sampled_at: string;
}

export interface ChronosPerfReport {
  schema: 'ce-08-chronos-perf/v1';
  thresholds: { min_fps: number; max_heap_mib: number };
  samples: ChronosPerfSample[];
  passed: boolean;
  generated_at: string;
}

export async function sampleChronosPage(
  page: Page,
  url: string,
  durationMs = 1_000
): Promise<ChronosPerfSample> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const result = await page.evaluate(async (duration) => {
    const start = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        frames += 1;
        if (performance.now() - start >= duration) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    return {
      frames,
      elapsed: Math.max(1, performance.now() - start),
      heap: memory?.usedJSHeapSize || null,
    };
  }, durationMs);
  return {
    url,
    avg_fps: Math.round(((result.frames * 1000) / result.elapsed) * 100) / 100,
    js_heap_mib: result.heap == null ? null : Math.round((result.heap / 1024 / 1024) * 100) / 100,
    sampled_at: new Date().toISOString(),
  };
}

function arg(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function startServer(port: string): ChildProcess {
  return spawn('pnpm', ['--dir', 'presence/displays/chronos-mirror-v2', 'start', '--port', port], {
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1' },
  });
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chronos did not become ready at ${url}`);
}

export async function runChronosPerfBaseline(argv: string[] = []): Promise<ChronosPerfReport> {
  const port = arg(argv, '--port', '3318');
  const baseUrl = arg(argv, '--url', `http://127.0.0.1:${port}`);
  const minFps = Number(arg(argv, '--min-fps', '55'));
  const maxHeap = Number(arg(argv, '--max-heap-mib', '120'));
  const ownedServer = argv.indexOf('--no-start') < 0;
  const server = ownedServer ? startServer(port) : undefined;
  try {
    await waitFor(baseUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      const paths = ['/', '/?view=agents', '/?view=deliverables'];
      const samples = [] as ChronosPerfSample[];
      for (const pathname of paths)
        samples.push(await sampleChronosPage(page, `${baseUrl}${pathname}`));
      const report: ChronosPerfReport = {
        schema: 'ce-08-chronos-perf/v1',
        thresholds: { min_fps: minFps, max_heap_mib: maxHeap },
        samples,
        passed: samples.every(
          (sample) =>
            sample.avg_fps >= minFps &&
            (sample.js_heap_mib == null || sample.js_heap_mib <= maxHeap)
        ),
        generated_at: new Date().toISOString(),
      };
      const output = pathResolver.shared('observability/chronos/ce-08-perf-baseline.json');
      safeWriteFile(output, `${JSON.stringify(report, null, 2)}\n`);
      return report;
    } finally {
      await browser.close();
    }
  } finally {
    if (ownedServer) server?.kill('SIGTERM');
  }
}

export const runCheckChronosPerf = defineScript({
  name: 'check:chronos-perf',
  flags: [],
  async run(context) {
    const report = await runChronosPerfBaseline(context.argv);
    context.print(report);
    if (!report.passed) throw new Error('Chronos performance thresholds were not met');
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_chronos_perf_baseline.ts') ||
  isDirectScript(import.meta.url, 'check_chronos_perf_baseline.js')
)
  void runCheckChronosPerf();
