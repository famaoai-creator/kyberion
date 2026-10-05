import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { writeVideoCompositionBundle } from './video-composition-compiler.js';
import type { VideoCompositionADF } from './video-composition-contract.js';
import { renderSceneTimelineRuntime, VIDEO_TIMELINE_CUE_CSS } from './video-timeline-runtime.js';

type FakeEl = { dataset: Record<string, string>; textContent: string; style: { opacity?: string } };

function runRuntime(script: string, nodes: Record<string, FakeEl[]>) {
  const animations = [
    {
      currentTime: 0,
      paused: false,
      pause() {
        this.paused = true;
      },
    },
    {
      currentTime: 0,
      paused: false,
      pause() {
        this.paused = true;
      },
    },
  ];
  const rootVars: Record<string, string> = {};
  const document = {
    readyState: 'complete',
    documentElement: { style: { setProperty: (k: string, v: string) => (rootVars[k] = v) } },
    querySelectorAll: (selector: string) => nodes[selector] || [],
    getAnimations: () => animations,
    addEventListener: () => {},
  };
  const window = {} as {
    __timelines: Record<string, { seek(t: number): void; time(): number }>;
    __hf: { seek(t: number): void };
  };
  // The runtime is one <script>…</script> block; take what is between the tags.
  const body = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</'));
  new Function('window', 'document', body)(window, document);
  return { window, animations, rootVars };
}

describe('video timeline runtime', () => {
  it('seeks every CSS animation and the cue helpers to the requested time', () => {
    const typed: FakeEl = {
      dataset: { type: 'こんにちは', at: '1', cps: '2' },
      textContent: '',
      style: {},
    };
    const count: FakeEl = {
      dataset: { count: '37', f: '0.5', dur: '1' },
      textContent: '',
      style: {},
    };
    const { window, animations, rootVars } = runRuntime(
      renderSceneTimelineRuntime({ sceneKey: 'hook', durationSec: 10, narrationSec: 4 }),
      { '[data-type]': [typed], '[data-count]': [count] }
    );

    window.__timelines.hook.seek(2.5);

    // CSS animations follow the seek instead of wall-clock time.
    expect(animations.every((a) => a.paused && a.currentTime === 2500)).toBe(true);
    // Typewriter: (2.5 - 1) * 2 cps = 3 characters.
    expect(typed.textContent).toBe('こんに');
    // Count-up starts at 0.5 * narration (2s) and is done after 1s → still mid-way at 2.5s.
    expect(Number(count.textContent)).toBeGreaterThan(0);
    expect(Number(count.textContent)).toBeLessThan(37);
    window.__hf.seek(3.5);
    expect(count.textContent).toBe('37');
    expect(rootVars['--kb-narration']).toBe('4');
    expect(window.__timelines.hook.time()).toBe(3.5);
  });

  it('registers cue variables as non-inheriting so nested cues do not start late', () => {
    expect(VIDEO_TIMELINE_CUE_CSS).toContain(
      "@property --f { syntax: '<number>'; inherits: false;"
    );
    expect(VIDEO_TIMELINE_CUE_CSS).toContain(
      "@property --at { syntax: '<number>'; inherits: false;"
    );
  });

  it('writes authored timeline-html scenes with the runtime and without template motion', () => {
    const bundleDir = pathResolver.sharedTmp('video-composition-bundle-tests/timeline-html');
    const adf: VideoCompositionADF = {
      kind: 'video-composition-adf',
      version: '1.0.0',
      intent: 'Timeline scene',
      title: 'Timeline scene',
      composition: { duration_sec: 6, fps: 30, width: 1920, height: 1080 },
      scenes: [
        {
          scene_id: 'intro',
          role: 'hook',
          start_sec: 0,
          duration_sec: 6,
          template_ref: { template_id: 'timeline-html' },
          content: {
            html: '<h1 class="kb-cue kb-rise" style="--at:.4">曖昧な依頼を、成果まで。</h1>',
            css: 'h1 { font-size: 96px; }',
            narration_sec: 4.2,
          },
        },
      ],
      output: { format: 'mp4', bundle_dir: bundleDir, emit_progress_packets: true },
    };

    writeVideoCompositionBundle(adf);
    const html = String(safeReadFile(`${bundleDir}/compositions/intro.html`, { encoding: 'utf8' }));
    expect(html).toContain('曖昧な依頼を、成果まで。');
    expect(html).toContain('data-kb-timeline-runtime');
    expect(html).toContain('const NARRATION = 4.2;');
    expect(html).toContain('data-kb-timeline-cues');
    expect(html).toContain('data-kb-typography');
    expect(html).not.toContain('data-kb-motion');
  });
});
