#!/usr/bin/env node

/* eslint-disable no-restricted-imports -- The contrast gate needs a long-lived local Next server; safeExec is synchronous and cannot provide a lifecycle handle. */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { defineScript, isDirectScript } from './lib/harness.js';

const DEFAULT_PORT = 3317;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

type Finding = {
  tag: string;
  text: string;
  ratio: number;
  threshold: number;
  color: string;
  background: string;
};

type Rgba = [number, number, number, number];

function parseRgba(value: string): Rgba | null {
  const match = value.match(/rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:[, ]+\s*([0-9.]+))?\)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : 1];
}

function blendOver(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const luminance = (rgba: Rgba): number => {
    const rgb = rgba.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePort(url: string): number {
  const parsed = new URL(url);
  return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
}

async function waitForServer(
  url: string,
  server: ChildProcess,
  getStartupOutput: () => string
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      const startupOutput = getStartupOutput();
      throw new Error(
        `Chronos exited before becoming ready (code ${server.exitCode}).${startupOutput ? `\n${startupOutput.trim()}` : ''}`
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const startupOutput = getStartupOutput();
  throw new Error(
    `Chronos did not become ready at ${url}.${startupOutput ? `\n${startupOutput.trim()}` : ''}`
  );
}

function startChronos(port: number): { child: ChildProcess; getStartupOutput: () => string } {
  const chronosRoot = resolve(process.cwd(), 'presence/displays/chronos-mirror-v2');
  let startupOutput = '';
  const child = spawn('pnpm', ['start', '--port', String(port)], {
    cwd: chronosRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1' },
    detached: process.platform !== 'win32',
  });
  const capture = (chunk: Buffer) => {
    startupOutput = `${startupOutput}${chunk.toString()}`.slice(-4000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return { child, getStartupOutput: () => startupOutput };
}

async function stopChronos(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && server.pid) {
        try {
          process.kill(-server.pid, signal);
        } catch {
          // The process group may already have exited.
        }
      }
      if (server.exitCode === null) server.kill(signal);
    };
    const timeout = setTimeout(() => {
      kill('SIGKILL');
      server.stdout?.destroy();
      server.stderr?.destroy();
      server.unref();
      resolve();
    }, 5_000);
    server.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    kill('SIGTERM');
  });
}

async function inspect(url: string, mode: 'light' | 'dark'): Promise<Finding[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ colorScheme: mode, reducedMotion: 'reduce' });
    page.setDefaultTimeout(120_000);
    await page.addInitScript((theme) => {
      window.localStorage.setItem('chronos.theme-mode', theme);
    }, mode);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Chronos resolves the system preference and applies the requested theme
    // in a client effect. A fixed delay was too short on slower CI runners,
    // so the contrast sample could capture the light background during the
    // dark-token first render (or vice versa).
    await page.waitForFunction(
      (expectedMode) => document.documentElement.dataset.theme === expectedMode,
      mode,
      { timeout: 10_000 }
    );
    await page.waitForFunction(
      (expectedMode) => {
        const main = document.querySelector('main');
        const secondary = main
          ? getComputedStyle(main).getPropertyValue('--kb-text-secondary')
          : '';
        return expectedMode === 'light'
          ? secondary.includes('15, 23, 42')
          : secondary.includes('248, 250, 252');
      },
      mode,
      { timeout: 10_000 }
    );
    // Let the first operator-home projection settle before sampling its
    // asynchronously rendered status copy.
    await page.waitForTimeout(1_000);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, mode);
    const samples = await page.evaluate(() => {
      const result: Array<{
        tag: string;
        text: string;
        color: string;
        backgroundLayers: string[];
        fontSize: string;
        fontWeight: string;
      }> = [];
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (element.getAttribute('aria-hidden') === 'true') continue;
        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .join(' ')
          .trim();
        if (!text) continue;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          !rect.width ||
          !rect.height ||
          style.visibility === 'hidden' ||
          style.display === 'none'
        )
          continue;
        let current: HTMLElement | null = element;
        const backgroundLayers: string[] = [];
        while (current) {
          const candidate = getComputedStyle(current).backgroundColor;
          if (candidate !== 'transparent' && !candidate.endsWith(', 0)')) {
            backgroundLayers.push(candidate);
          }
          current = current.parentElement;
        }
        backgroundLayers.reverse();
        result.push({
          tag: element.tagName.toLowerCase(),
          text: text.slice(0, 120),
          color: style.color,
          backgroundLayers,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
        });
      }
      return result;
    });
    return samples.flatMap((sample) => {
      const foreground = parseRgba(sample.color);
      if (!foreground) return [];
      let background: Rgba = [255, 255, 255, 1];
      for (const layer of sample.backgroundLayers) {
        const parsed = parseRgba(layer);
        if (parsed && parsed[3] > 0) background = blendOver(parsed, background);
      }
      const measured = contrastRatio(
        foreground[3] < 1 ? blendOver(foreground, background) : foreground,
        background
      );
      const fontSize = Number.parseFloat(sample.fontSize);
      const fontWeight = Number.parseInt(sample.fontWeight, 10);
      const threshold = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700) ? 3 : 4.5;
      if (measured >= threshold) return [];
      return [
        {
          tag: sample.tag,
          text: sample.text,
          ratio: Number(measured.toFixed(2)),
          threshold,
          color: sample.color,
          background: `rgb(${Math.round(background[0])}, ${Math.round(background[1])}, ${Math.round(background[2])})`,
        },
      ];
    });
  } finally {
    await browser.close();
  }
}

export const runCheckChronosDomContrast = defineScript({
  name: 'check:chronos-dom-contrast',
  flags: [],
  async run(context) {
    const url = argument(context.argv, '--url') ?? DEFAULT_URL;
    const shouldStart = context.argv.includes('--start');
    let server: ChildProcess | undefined;
    try {
      if (shouldStart) {
        const started = startChronos(parsePort(url));
        server = started.child;
        await waitForServer(url, server, started.getStartupOutput);
      }
      const requestedMode = argument(context.argv, '--mode');
      const modes: Array<'light' | 'dark'> =
        requestedMode === 'light' || requestedMode === 'dark' ? [requestedMode] : ['light', 'dark'];
      const findings = (await Promise.all(modes.map((mode) => inspect(url, mode)))).flat();
      if (findings.length > 0) {
        console.error(`[check:chronos-dom-contrast] ${findings.length} violation(s)`);
        for (const finding of findings.slice(0, 20)) {
          console.error(
            `- ${finding.tag} ${finding.ratio}:1 < ${finding.threshold}:1 ${finding.color} on ${finding.background} ${finding.text}`
          );
        }
        throw new Error(`${findings.length} Chronos contrast violation(s)`);
      }
      context.print(`[check:chronos-dom-contrast] OK (${modes.join(' + ')}, reduced-motion)`);
    } finally {
      if (server) await stopChronos(server);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'check_chronos_dom_contrast.ts') ||
  isDirectScript(import.meta.url, 'check_chronos_dom_contrast.js')
)
  void runCheckChronosDomContrast();
