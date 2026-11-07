/**
 * Seekable timeline runtime shared by every video-composition scene.
 *
 * HyperFrames captures a frame by asking the page to seek to `t`. Scenes run
 * inside iframes, so the HyperFrames runtime in the top document never sees
 * their CSS animations; each scene has to move its own clock. This runtime
 * pauses every animation in the scene document and sets `currentTime` to the
 * requested time, so CSS `@keyframes` (template motion, authored timeline
 * scenes) render deterministically frame by frame.
 *
 * Authored timeline scenes can also use cue helpers. Times are seconds from
 * scene start, plus an optional fraction of the scene's narration length:
 *   - CSS: `class="kb-cue kb-rise" style="--at:.4; --f:.35"` → starts at 0.4s + 35% of narration
 *   - `data-type="text" data-at data-f data-cps` → typewriter
 *   - `data-count="37" data-at data-f data-dur` → count-up
 *   - `data-blink` → caret blink
 * Cue variables are registered with `@property … inherits: false`: as plain
 * custom properties a nested element would silently inherit its wrapper's
 * cue and start late.
 */

export interface SceneTimelineRuntimeOptions {
  sceneKey: string;
  durationSec: number;
  /** Narration length inside this scene; `--f` cues scale against it. */
  narrationSec?: number;
}

/** Cue CSS: non-inheriting cue vars plus entrance primitives for authored scenes. */
export const VIDEO_TIMELINE_CUE_CSS = `<style data-kb-timeline-cues>
@property --at { syntax: '<number>'; inherits: false; initial-value: 0; }
@property --f { syntax: '<number>'; inherits: false; initial-value: 0; }
@property --du { syntax: '<time>'; inherits: false; initial-value: 0.9s; }
.kb-cue {
  animation-duration: var(--du);
  animation-timing-function: cubic-bezier(.16, 1, .3, 1);
  animation-fill-mode: both;
  animation-delay: calc((var(--at) + var(--f) * var(--kb-narration, 0)) * 1s);
}
.kb-rise { animation-name: kb-rise; } @keyframes kb-rise { from { opacity: 0; transform: translateY(34px); } to { opacity: 1; transform: none; } }
.kb-fade { animation-name: kb-fade; } @keyframes kb-fade { from { opacity: 0; } to { opacity: 1; } }
.kb-scale { animation-name: kb-scale; } @keyframes kb-scale { from { opacity: 0; transform: scale(.86); } to { opacity: 1; transform: none; } }
.kb-pop { animation-name: kb-pop; --du: .55s; } @keyframes kb-pop { 0% { opacity: 0; transform: scale(.4); } 70% { opacity: 1; transform: scale(1.06); } 100% { opacity: 1; transform: none; } }
.kb-left { animation-name: kb-left; } @keyframes kb-left { from { opacity: 0; transform: translateX(-60px); } to { opacity: 1; transform: none; } }
.kb-right { animation-name: kb-right; } @keyframes kb-right { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: none; } }
.kb-focus { animation-name: kb-focus; --du: 1.4s; } @keyframes kb-focus { from { opacity: 0; filter: blur(18px); } to { opacity: 1; filter: blur(0); } }
.kb-wipe { animation-name: kb-wipe; --du: .7s; } @keyframes kb-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
.kb-out { animation-name: kb-out; --du: .6s; } @keyframes kb-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-20px); } }
</style>`;

function finiteSeconds(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** `<script>` that registers `window.__hf` / `window.__timelines[sceneKey]` with a real seek. */
export function renderSceneTimelineRuntime(options: SceneTimelineRuntimeOptions): string {
  const duration = finiteSeconds(options.durationSec, 0);
  const narration = finiteSeconds(options.narrationSec, duration);
  const key = JSON.stringify(String(options.sceneKey));
  return `<script data-kb-timeline-runtime>
(() => {
  const DURATION = ${duration};
  const NARRATION = ${narration};
  let current = 0;
  document.documentElement.style.setProperty('--kb-narration', String(NARRATION));
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const cueStart = (el) => (Number(el.dataset.at) || 0) + (Number(el.dataset.f) || 0) * NARRATION;
  function seek(time) {
    const t = Math.max(0, Number(time) || 0);
    current = t;
    const root = document.documentElement;
    root.style.setProperty('--kb-t', t.toFixed(4));
    root.style.setProperty('--kb-p', clamp01(DURATION > 0 ? t / DURATION : 0).toFixed(4));
    document.querySelectorAll('[data-type]').forEach((el) => {
      const full = el.dataset.type || '';
      const cps = Number(el.dataset.cps) || 12;
      const k = Math.max(0, Math.min(full.length, Math.floor((t - cueStart(el)) * cps)));
      el.textContent = full.slice(0, k);
    });
    document.querySelectorAll('[data-count]').forEach((el) => {
      const p = easeOut(clamp01((t - cueStart(el)) / (Number(el.dataset.dur) || 1.2)));
      el.textContent = String(Math.round(Number(el.dataset.count) * p));
    });
    document.querySelectorAll('[data-blink]').forEach((el) => {
      el.style.opacity = Math.floor(t * 2.2) % 2 ? '0' : '1';
    });
    if (typeof document.getAnimations === 'function') {
      document.getAnimations().forEach((animation) => {
        animation.pause();
        animation.currentTime = t * 1000;
      });
    }
  }
  const timeline = {
    duration: () => DURATION,
    time: () => current,
    pause: () => {},
    play: () => {},
    seek,
    totalTime: seek,
    isPlaying: () => false,
    setPlaybackRate: () => {},
    getPlaybackRate: () => 1,
  };
  window.__hf = { duration: DURATION, seek };
  window.__timelines = window.__timelines || {};
  window.__timelines[${key}] = timeline;
  const start = () => seek(0);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
</script>`;
}
