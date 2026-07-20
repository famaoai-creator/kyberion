import * as path from 'node:path';
import {
  normalizeVideoVisualDirection,
  visualDirectionToCssVars,
  type VideoVisualDirection,
} from './video-visual-direction.js';
import {
  motionDirectionToCss,
  normalizeVideoMotionDirection,
  type VideoMotionDirection,
} from './video-motion-direction.js';
import {
  normalizeSceneComposition,
  sceneCompositionToCss,
  type SceneComposition,
} from './video-scene-composition.js';
import { getVideoCompositionTemplateRecord } from './video-composition-template-registry.js';
import { getVideoRenderRuntimePolicy } from './video-render-runtime-policy.js';
import * as pathResolver from './path-resolver.js';
import { slugify } from './text-utils.js';
import { safeCopyFileSync, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { buildVideoDesignCssVars } from './video-design-system.js';
import type {
  CompiledVideoCompositionScene,
  VideoCompositionADF,
  VideoCompositionAssetRef,
  VideoCompositionRenderPlan,
  VideoCompositionScene,
} from './video-composition-contract.js';

export function compileVideoCompositionADF(
  adf: VideoCompositionADF,
  options?: { bundleDir?: string }
): VideoCompositionRenderPlan {
  const policy = getVideoRenderRuntimePolicy();
  const bundleDir = pathResolver.rootResolve(
    options?.bundleDir ||
      adf.output.bundle_dir ||
      buildDefaultBundleDir(adf, policy.bundle.default_bundle_root)
  );
  const compositionId = slugify(adf.intent || adf.title || 'video-composition');
  const backgroundColor = adf.composition.background_color || '#0B1020';

  if (!policy.render.allowed_output_formats.includes(adf.output.format)) {
    throw new Error(`Unsupported composed-video output format: ${adf.output.format}`);
  }

  const compiledScenes = adf.scenes
    .slice()
    .sort((a, b) => a.start_sec - b.start_sec)
    .map((scene) => compileScene(scene, adf));

  const endTime = compiledScenes.reduce(
    (max, scene) => Math.max(max, scene.start_sec + scene.duration_sec),
    0
  );
  if (endTime > adf.composition.duration_sec + 0.0001) {
    throw new Error(
      `Scene timings exceed composition duration (${endTime}s > ${adf.composition.duration_sec}s)`
    );
  }

  const indexHtml = path.join(bundleDir, 'index.html');
  const artifactRefs = [
    indexHtml,
    path.join(bundleDir, 'render-plan.json'),
    ...compiledScenes.map((scene) => path.join(bundleDir, scene.output_html)),
  ];

  if (adf.audio?.narration_ref) {
    artifactRefs.push(pathResolver.rootResolve(adf.audio.narration_ref));
  }
  if (adf.audio?.music_ref) {
    artifactRefs.push(pathResolver.rootResolve(adf.audio.music_ref));
  }

  return {
    kind: 'video-composition-render-plan',
    version: adf.version,
    composition_id: compositionId,
    source_kind: 'video-composition-adf',
    title: adf.title || adf.intent || 'Kyberion Video Composition',
    narration_ref: adf.audio?.narration_ref
      ? pathResolver.rootResolve(adf.audio.narration_ref)
      : undefined,
    music_ref: adf.audio?.music_ref ? pathResolver.rootResolve(adf.audio.music_ref) : undefined,
    duration_sec: adf.composition.duration_sec,
    fps: adf.composition.fps,
    width: adf.composition.width,
    height: adf.composition.height,
    background_color: backgroundColor,
    output_format: adf.output.format,
    output_target_path: adf.output.target_path,
    bundle_dir: bundleDir,
    index_html: indexHtml,
    scenes: compiledScenes,
    artifact_refs: artifactRefs,
  };
}

export function writeVideoCompositionBundle(
  adf: VideoCompositionADF,
  options?: { bundleDir?: string }
): VideoCompositionRenderPlan {
  const policy = getVideoRenderRuntimePolicy();
  const plan = compileVideoCompositionADF(adf, options);
  safeMkdir(plan.bundle_dir, { recursive: true });
  safeMkdir(path.join(plan.bundle_dir, 'compositions'), { recursive: true });

  const motionDirection = resolveAdfMotionDirection(adf);

  for (const scene of plan.scenes) {
    const sceneSource = applySceneComposition(
      applySceneMotion(
        applyVideoThemeTokens(renderSceneHtml(adf, scene), resolveAdfVisualDirection(adf)),
        scene,
        motionDirection
      ),
      scene,
      adf.composition.scene_compositions
    );
    const scenePath = path.join(plan.bundle_dir, scene.output_html);
    safeWriteFile(scenePath, sceneSource);

    // Always copy declared assets to ensure relative paths work correctly in Puppeteer
    copySceneAssets(plan.bundle_dir, scene.asset_refs);
  }

  safeWriteFile(
    plan.index_html,
    applyVideoThemeTokens(renderBundleIndexHtml(plan, adf), resolveAdfVisualDirection(adf))
  );
  safeWriteFile(path.join(plan.bundle_dir, 'render-plan.json'), JSON.stringify(plan, null, 2));
  safeWriteFile(path.join(plan.bundle_dir, 'README.md'), renderBundleReadme(plan, adf));

  return plan;
}

function compileScene(
  scene: VideoCompositionScene,
  adf: VideoCompositionADF
): CompiledVideoCompositionScene {
  const role = scene.role || 'generic';
  const directedLayout = resolveAdfVisualDirection(adf).per_scene?.find(
    (entry) => entry.scene_id === scene.scene_id
  )?.layout_variant;
  // Visual-direction layout assignment: only when the ADF did not pin a
  // template explicitly, and only if the scene satisfies the target
  // template's required content fields (otherwise keep the original —
  // a layout choice must never fail a previously valid compile).
  let requestedTemplateId = scene.template_ref?.template_id;
  if (!requestedTemplateId && directedLayout && directedLayout !== 'default') {
    const candidate = getVideoCompositionTemplateRecord(directedLayout);
    const satisfiable =
      candidate.template_id === directedLayout &&
      candidate.supported_roles.includes(role) &&
      candidate.supported_output_formats.includes(adf.output.format) &&
      candidate.required_content_fields.every((field) => {
        const value = scene.content?.[field];
        return typeof value === 'string' && value.trim().length > 0;
      });
    if (satisfiable) requestedTemplateId = directedLayout;
  }
  const template = getVideoCompositionTemplateRecord(requestedTemplateId);
  const sceneKey = safeSceneKey(scene.scene_id);
  if (template.status !== 'active') {
    throw new Error(`Template ${template.template_id} is not active`);
  }
  if (!template.supported_roles.includes(role)) {
    throw new Error(`Template ${template.template_id} does not support scene role ${role}`);
  }
  if (!template.supported_output_formats.includes(adf.output.format)) {
    throw new Error(
      `Template ${template.template_id} does not support output format ${adf.output.format}`
    );
  }
  for (const field of template.required_content_fields) {
    const value = scene.content?.[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `Scene ${scene.scene_id} is missing required content field "${field}" for template ${template.template_id}`
      );
    }
  }

  return {
    scene_id: scene.scene_id,
    role,
    start_sec: scene.start_sec,
    duration_sec: scene.duration_sec,
    template_id: template.template_id,
    template_display_name: template.display_name,
    output_html: path.join('compositions', `${sceneKey}.html`),
    required_content_fields: template.required_content_fields,
    content: { ...scene.content },
    asset_refs: mergeSceneAssetRefs(scene.asset_refs || [], extractAvatarAssetRefs(scene)),
  };
}

function renderSceneHtml(adf: VideoCompositionADF, scene: CompiledVideoCompositionScene): string {
  const sceneKey = safeSceneKey(scene.scene_id);
  const sceneCssVars = renderSceneCssVars(scene, adf);
  const layoutVariant = sceneLayoutVariant(scene);
  // Templates declare `headline` (and sometimes `title`) as the
  // canonical content field — basic-title-card / split-highlight both
  // ship `headline` in their `required_content_fields`. Older ADFs
  // wrote `title` directly, so we accept either to keep both shapes
  // working.
  const title = sceneText(scene, 'headline') || sceneText(scene, 'title');
  const body = sceneText(scene, 'body');
  const eyebrow = sceneText(scene, 'eyebrow');
  const supporting = resolveAsset(scene.asset_refs, 'supporting');
  const avatar = resolveAvatarAsset(scene, supporting);
  const visualSteps = Array.isArray(scene.content.visual_steps)
    ? scene.content.visual_steps
        .map((step: any, index: number) => ({
          step: String(step?.step ?? String(index + 1).padStart(2, '0')),
          detail: String(step?.detail ?? step?.title ?? step?.label ?? ''),
        }))
        .filter((step: any) => step.detail)
    : [];
  const visualMarkup = supporting
    ? `<img src="${escapeHtml(supporting.path)}" alt="visual">`
    : `<div class="process-visual">
        ${
          visualSteps.length > 0
            ? visualSteps
                .map(
                  (step: any, index: number) => `
              <div class="process-step">
                <span>${escapeHtml(step.step)}</span>
                <strong>${escapeHtml(step.detail)}</strong>
                <small>${escapeHtml(sceneText(scene, 'caption') || sceneText(scene, 'body') || `Beat ${index + 1}`)}</small>
              </div>
              ${index < visualSteps.length - 1 ? '<div class="process-arrow"></div>' : ''}
            `
                )
                .join('')
            : ''
        }
      </div>`;
  const hfScript = `<script>
  const __hfTimeline = {
    duration: () => ${scene.duration_sec},
    time: () => 0,
    pause: () => {},
    play: () => {},
    seek: (time) => { console.log('[HF] seek', time); },
    totalTime: (time) => { console.log('[HF] totalTime', time); },
    isPlaying: () => false,
    setPlaybackRate: () => {},
    getPlaybackRate: () => 1,
  };
  window.__hf = {
    duration: ${scene.duration_sec},
    seek: (time) => { console.log('[HF] seek', time); }
  };
  window.__timelines = window.__timelines || {};
  window.__timelines["${sceneKey}"] = __hfTimeline;
</script>`;

  if (scene.template_id === 'howto-guide') {
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      ${sceneCssVars}
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
        background: radial-gradient(circle at top left, rgba(59,130,246,0.16), transparent 32%), var(--bg);
        color: var(--text);
      }
      .frame {
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: 0.95fr 1.05fr;
        gap: 36px;
        padding: 56px;
        align-items: center;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--kb-accent-blue-soft, #93c5fd);
        margin-bottom: 18px;
      }
      .eyebrow::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--kb-accent-blue, #60a5fa);
        box-shadow: 0 0 18px rgba(96,165,250,0.6);
      }
      h1 {
        margin: 0 0 16px;
        font-size: 68px;
        line-height: 1.03;
        letter-spacing: -0.05em;
      }
      .body {
        color: var(--subtext);
        font-size: 23px;
        line-height: 1.6;
        max-width: 620px;
      }
      .rail {
        display: grid;
        gap: 18px;
        padding: 24px;
        border-radius: 28px;
        background: var(--panel);
        border: 1px solid rgba(148,163,184,0.16);
        box-shadow: 0 30px 80px rgba(0,0,0,0.35);
      }
      .step {
        display: grid;
        grid-template-columns: 64px 1fr;
        gap: 16px;
        align-items: center;
        padding: 18px 20px;
        border-radius: 20px;
        background: rgba(7,17,31,0.76);
        border: 1px solid rgba(148,163,184,0.12);
      }
      .step span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 18px;
        background: rgba(96,165,250,0.16);
        color: var(--kb-accent-blue-text, #bfdbfe);
        font-weight: 800;
        letter-spacing: 0.08em;
      }
      .step strong { font-size: 20px; display: block; margin-bottom: 2px; }
      .step small { color: var(--subtext); line-height: 1.45; }
      .summary {
        margin-top: 20px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .pill {
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(96,165,250,0.12);
        color: var(--kb-accent-blue-muted, #cfe3ff);
        border: 1px solid rgba(96,165,250,0.18);
        font-size: 14px;
      }
      .visual {
        min-height: 640px;
        border-radius: 30px;
        background: linear-gradient(180deg, rgba(15,23,42,0.96), rgba(3,7,18,0.96));
        border: 1px solid rgba(148,163,184,0.14);
        box-shadow: 0 40px 100px rgba(0,0,0,0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 34px;
        position: relative;
        overflow: hidden;
      }
      .visual::after {
        content: '';
        position: absolute;
        inset: 28px;
        border-radius: 24px;
        border: 1px dashed rgba(96,165,250,0.28);
      }
      .visual img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 22px;
        opacity: 0.92;
      }
      .visual .fallback {
        text-align: center;
        max-width: 360px;
      }
      .visual .fallback h2 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      .visual .fallback p {
        margin: 0;
        color: var(--subtext);
        font-size: 18px;
        line-height: 1.55;
      }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
      <div class="frame">
        <div>
          ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
          <h1>${escapeHtml(title || 'How-to')}</h1>
          <div class="body">${escapeHtml(body)}</div>
          <div class="summary">
            ${(Array.isArray(scene.content.visual_steps) ? scene.content.visual_steps : [])
              .slice(0, 4)
              .map(
                (step: any) =>
                  `<div class="pill">${escapeHtml(String(step.step ?? ''))} ${escapeHtml(String(step.detail ?? ''))}</div>`
              )
              .join('')}
          </div>
        </div>
        <div class="visual">
          ${
            supporting
              ? `<img src="${escapeHtml(supporting.path)}" alt="visual">`
              : `
            <div class="fallback">
              <h2>Ordered steps</h2>
              <p>${escapeHtml(sceneText(scene, 'caption') || 'Audience, use case, constraints, and render output are sequenced as a governed flow.')}</p>
            </div>
          `
          }
        </div>
      </div>
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'promo-spot') {
    const valuePoints = Array.isArray(scene.content.value_points)
      ? scene.content.value_points.map((value: any) => String(value)).filter(Boolean)
      : [];
    const proofPoints = Array.isArray(scene.content.social_proof)
      ? scene.content.social_proof.map((value: any) => String(value)).filter(Boolean)
      : [];
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      ${sceneCssVars}
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
        background: radial-gradient(circle at top right, rgba(249,115,22,0.18), transparent 30%), var(--bg, #060913);
        color: var(--text, white);
      }
      .shell {
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: 1fr 0.95fr;
        gap: 28px;
        padding: 54px;
        align-items: center;
      }
      .kicker {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-transform: uppercase;
        letter-spacing: 0.22em;
        color: var(--kb-accent-orange, #f59e0b);
        font-size: 13px;
        margin-bottom: 16px;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 74px;
        line-height: 0.98;
        letter-spacing: -0.06em;
      }
      .body {
        max-width: 640px;
        color: #cbd5e1;
        font-size: 24px;
        line-height: 1.55;
        margin-bottom: 24px;
      }
      .stack { display: grid; gap: 14px; }
      .card {
        padding: 18px 20px;
        border-radius: 20px;
        background: rgba(15,23,42,0.9);
        border: 1px solid rgba(148,163,184,0.12);
        box-shadow: 0 24px 60px rgba(0,0,0,0.25);
      }
      .card strong { display: block; font-size: 18px; margin-bottom: 4px; }
      .card small { color: #cbd5e1; font-size: 15px; line-height: 1.45; }
      .proof-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
      .chip {
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(249,115,22,0.14);
        color: #fed7aa;
        border: 1px solid rgba(249,115,22,0.22);
        font-size: 14px;
      }
      .visual {
        height: 100%;
        border-radius: 32px;
        background: linear-gradient(180deg, rgba(15,23,42,0.96), rgba(7,17,31,0.96));
        border: 1px solid rgba(148,163,184,0.12);
        box-shadow: 0 36px 90px rgba(0,0,0,0.45);
        padding: 24px;
        display: grid;
        align-content: center;
        gap: 18px;
      }
      .hero-block {
        padding: 22px;
        border-radius: 24px;
        background: linear-gradient(135deg, rgba(249,115,22,0.2), rgba(59,130,246,0.08));
        border: 1px solid rgba(249,115,22,0.22);
      }
      .hero-block .metric {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .metric div {
        padding: 16px;
        border-radius: 18px;
        background: rgba(7,17,31,0.7);
        border: 1px solid rgba(148,163,184,0.12);
      }
      .metric span { display: block; color: var(--kb-accent-orange, #f59e0b); font-size: 12px; text-transform: uppercase; letter-spacing: 0.18em; margin-bottom: 8px; }
      .metric strong { font-size: 22px; line-height: 1.15; }
      @keyframes pulse { from { transform: translateY(0); } to { transform: translateY(-6px); } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
      <div class="shell">
        <div>
          <div class="kicker">Promo spot</div>
          <h1>${escapeHtml(title || 'Promo')}</h1>
          <div class="body">${escapeHtml(body)}</div>
          <div class="stack">
            ${valuePoints.map((value: string, index: number) => `<div class="card"><strong>Value ${String(index + 1).padStart(2, '0')}</strong><small>${escapeHtml(value)}</small></div>`).join('')}
          </div>
          <div class="proof-row">
            ${proofPoints.map((value: string) => `<div class="chip">${escapeHtml(value)}</div>`).join('')}
          </div>
        </div>
        <div class="visual">
          <div class="hero-block">
            <div class="metric">
              <div><span>Promise</span><strong>${escapeHtml(sceneText(scene, 'caption') || 'Clear value in the first beat')}</strong></div>
              <div><span>Proof</span><strong>${escapeHtml(proofPoints[0] || sceneText(scene, 'caption') || 'Artifact-backed')}</strong></div>
              <div><span>Action</span><strong>${escapeHtml(sceneText(scene, 'caption') || 'Strong CTA')}</strong></div>
            </div>
          </div>
          ${supporting ? `<img src="${escapeHtml(supporting.path)}" alt="visual" style="width:100%;height:320px;object-fit:cover;border-radius:24px;">` : ''}
        </div>
      </div>
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'vtuber-stage') {
    const chatMessages = Array.isArray(scene.content.chat_messages)
      ? scene.content.chat_messages
      : [];
    const stageNotes = Array.isArray(scene.content.stage_notes) ? scene.content.stage_notes : [];

    const pageScript = `<script>
      window.addEventListener('DOMContentLoaded', () => {
        const animElements = [
          { el: document.querySelector('.avatar'), delay: 0, duration: 1.0 },
          { el: document.querySelector('.panel'), delay: 0.2, duration: 1.2 }
        ];
        document.querySelectorAll('.bubble').forEach((bubble, idx) => {
          animElements.push({ el: bubble, delay: 0.6 + idx * 0.4, duration: 0.8 });
        });
        document.querySelectorAll('.tag').forEach((tag, idx) => {
          animElements.push({ el: tag, delay: 1.2 + idx * 0.2, duration: 0.6 });
        });

        function performSeek(time) {
          animElements.forEach(item => {
            if (!item.el) return;
            let elapsed = time - item.delay;
            if (elapsed < 0) elapsed = 0;
            if (elapsed > item.duration) elapsed = item.duration;
            item.el.style.animationDelay = \`-\${elapsed}s\`;
          });
        }

        function waitForImages() {
          const imgs = Array.from(document.querySelectorAll('img'));
          const promises = imgs.map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
              img.onload = resolve;
              img.onerror = resolve;
            });
          });
          return Promise.all(promises);
        }

        const __hfTimeline = {
          duration: () => ${scene.duration_sec},
          time: () => 0,
          pause: () => {},
          play: () => {},
          seek: (time) => { performSeek(time); },
          totalTime: (time) => { performSeek(time); },
          isPlaying: () => false,
          setPlaybackRate: () => {},
          getPlaybackRate: () => 1,
        };
        window.__hf = {
          duration: ${scene.duration_sec},
          seek: (time) => { performSeek(time); }
        };
        window.__timelines = window.__timelines || {};
        window.__timelines["${sceneKey}"] = __hfTimeline;

        waitForImages().then(() => {
          performSeek(0);
        });
      });
    </script>`;

    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      ${sceneCssVars}
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
        background:
          radial-gradient(circle at top left, rgba(34,197,94,0.14), transparent 24%),
          radial-gradient(circle at bottom right, rgba(59,130,246,0.18), transparent 28%),
          var(--bg, #050714);
        color: var(--text, white);
      }
      .stage {
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: 0.78fr 1.22fr;
        gap: 28px;
        padding: 48px;
        align-items: stretch;
      }
      .stage.stage--focus-center {
        grid-template-columns: 1fr;
        align-items: center;
      }
      .stage.stage--focus-center .avatar {
        min-height: 58%;
      }
      .stage.stage--focus-center .panel {
        min-height: 30%;
      }
      .stage.stage--split-right {
        grid-template-columns: 1.22fr 0.78fr;
      }
      .stage.stage--fullscreen-demo {
        grid-template-columns: 0.58fr 1.42fr;
      }
      .avatar {
        border-radius: var(--radius-panel, 32px);
        background: linear-gradient(180deg, rgba(15,23,42,0.96), rgba(7,17,31,0.9));
        border: 1px solid rgba(148,163,184,0.14);
        box-shadow: 0 36px 90px rgba(0,0,0,0.45);
        display: grid;
        place-items: center;
        position: relative;
        overflow: hidden;
      }
      .avatar::before {
        content: 'LIVE';
        position: absolute;
        top: 22px;
        left: 22px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(220,38,38,0.2);
        color: #fecaca;
        border: 1px solid rgba(248,113,113,0.2);
        font-size: 12px;
        letter-spacing: 0.22em;
        z-index: 10;
      }
      .avatar-circle {
        width: 240px;
        height: 240px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: radial-gradient(circle, rgba(59,130,246,0.24), rgba(15,23,42,0.9));
        border: 1px solid rgba(96,165,250,0.22);
        box-shadow: inset 0 0 0 8px rgba(7,17,31,0.6), 0 24px 60px rgba(0,0,0,0.3);
        font-size: 56px;
        font-weight: 900;
        letter-spacing: -0.06em;
        overflow: hidden;
      }
      .avatar-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .avatar-meta {
        position: absolute;
        left: 24px;
        right: 24px;
        bottom: 24px;
        display: grid;
        gap: 12px;
      }
      .persona-line {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--kb-accent-blue-soft, #93c5fd);
      }
      .persona-line::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--kb-accent-green, #22c55e);
        box-shadow: 0 0 16px rgba(34,197,94,0.5);
      }
      .panel {
        border-radius: var(--radius-panel, 32px);
        background: linear-gradient(180deg, rgba(15,23,42,0.95), rgba(7,17,31,0.94));
        border: 1px solid rgba(148,163,184,0.14);
        box-shadow: 0 36px 90px rgba(0,0,0,0.45);
        padding: 34px;
        display: grid;
        gap: 18px;
      }
      .panel h1 {
        margin: 0;
        font-size: 68px;
        line-height: 1.02;
        letter-spacing: -0.05em;
      }
      .panel .body {
        color: #cbd5e1;
        font-size: 22px;
        line-height: 1.55;
        max-width: 640px;
      }
      .chat {
        display: grid;
        gap: 12px;
      }
      .bubble {
        max-width: 100%;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(7,17,31,0.76);
        border: 1px solid rgba(148,163,184,0.12);
      }
      .bubble strong {
        display: block;
        margin-bottom: 4px;
        color: var(--kb-accent-blue-soft, #93c5fd);
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-size: 12px;
      }
      .bubble p {
        margin: 0;
        color: #e2e8f0;
        font-size: 18px;
        line-height: 1.5;
      }
      .notes {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .tag {
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(34,197,94,0.12);
        color: var(--kb-accent-green-muted, #bbf7d0);
        border: 1px solid var(--kb-accent-green-soft, rgba(34,197,94,0.18));
        font-size: 14px;
      }

      /* Animation Seeking */
      @keyframes slideInLeft {
        from { transform: translateX(-100px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideInRight {
        from { transform: translateX(100px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes popIn {
        0% { transform: scale(0.8); opacity: 0; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes bubbleAppear {
        0% { transform: scale(0.9) translateY(20px); opacity: 0; }
        100% { transform: scale(1) translateY(0); opacity: 1; }
      }
      @keyframes breathe {
        from { transform: scale(1); }
        to { transform: scale(1.03); }
      }

      .avatar {
        animation: slideInLeft 1s cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-play-state: paused;
      }
      .avatar-circle {
        animation: breathe 4s ease-in-out infinite alternate;
      }
      .panel {
        animation: slideInRight 1.2s cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-play-state: paused;
      }
      .bubble {
        animation: bubbleAppear 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-play-state: paused;
      }
      .tag {
        animation: popIn 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
        animation-play-state: paused;
      }
    </style>
  </head>
  <body data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${sceneKey}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
      <div class="stage stage--${escapeHtml(layoutVariant)}">
        <div class="avatar">
          <div class="avatar-circle">
            ${avatar ? `<img src="../assets/${escapeHtml(path.basename(avatar.path))}" alt="avatar" class="avatar-img">` : escapeHtml((eyebrow || 'K').slice(0, 1))}
          </div>
          <div class="avatar-meta">
            <div class="persona-line">${escapeHtml(eyebrow || 'Kyberion')}</div>
            <div class="body">${escapeHtml(body)}</div>
          </div>
        </div>
        <div class="panel">
          <h1>${escapeHtml(title || 'VTuber Stage')}</h1>
          <div class="body">${escapeHtml(sceneText(scene, 'caption') || sceneText(scene, 'visual_direction') || body)}</div>
          <div class="chat">
            ${chatMessages.map((message: any) => `<div class="bubble"><strong>${escapeHtml(String(message?.speaker || 'voice'))}</strong><p>${escapeHtml(String(message?.text || ''))}</p></div>`).join('')}
          </div>
          <div class="notes">
            ${stageNotes.map((note: any) => `<div class="tag">${escapeHtml(String(note))}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>
    ${pageScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'split-highlight') {
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      ${sceneCssVars}
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
        background: var(--bg);
        color: var(--text);
      }
      .container {
        display: flex;
        width: 100%;
        height: 100%;
        padding: 60px;
        gap: 40px;
        align-items: center;
        
      }
      .content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 24px;
        z-index: 10;
      }
      .eyebrow {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--accent);
        opacity: 0.8;
      }
      h1 {
        margin: 0;
        font-size: 64px;
        line-height: 1.1;
        font-weight: 800;
        background: linear-gradient(to bottom right, #fff, #94a3b8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .body {
        font-size: 24px;
        line-height: 1.6;
        color: var(--subtext);
        max-width: 600px;
      }
      .visual {
        flex: 1;
        height: 100%;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 24px;
        overflow: hidden;
        position: relative;
        box-shadow: 0 40px 100px rgba(0,0,0,0.5);
      }
      .visual img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0.9;
        transform: scale(1.05);
        
      }
      .process-visual {
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 18px;
        padding: 40px;
      }
      .process-step {
        display: grid;
        grid-template-columns: 64px 1fr;
        grid-template-rows: auto auto;
        column-gap: 18px;
        align-items: center;
        padding: 18px 20px;
        border-radius: 20px;
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.18);
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
      }
      .process-step span {
        grid-row: 1 / span 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 18px;
        background: rgba(59, 130, 246, 0.16);
        color: var(--kb-accent-blue-soft, #93c5fd);
        font-weight: 800;
        font-size: 16px;
        letter-spacing: 0.08em;
      }
      .process-step strong {
        font-size: 22px;
        line-height: 1.2;
      }
      .process-step small {
        color: #94a3b8;
        font-size: 15px;
        line-height: 1.5;
      }
      .process-arrow {
        width: 2px;
        height: 18px;
        margin-left: 28px;
        background: linear-gradient(to bottom, rgba(147, 197, 253, 0), rgba(147, 197, 253, 0.9), rgba(147, 197, 253, 0));
      }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes zoomIn { from { transform: scale(1); } to { transform: scale(1.1); } }
      .grid {
        position: absolute;
        inset: 0;
        background-image: radial-gradient(rgba(59, 130, 246, 0.1) 1px, transparent 1px);
        background-size: 40px 40px;
        z-index: 1;
      }
    </style>
  </head>
  <body
    data-composition-id="${sceneKey}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${sceneKey}"
      data-width="${adf.composition.width}"
      data-height="${adf.composition.height}"
      data-duration="${scene.duration_sec}"
      data-start="0"
    >
    <div class="grid"></div>
    <div class="container">
      <div class="content">
        ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
        <h1>${escapeHtml(title || 'Mission Logic')}</h1>
        <div class="body">${escapeHtml(body)}</div>
      </div>
      <div class="visual">
        ${visualMarkup}
      </div>
    </div>
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'quote-card') {
    const attribution = eyebrow || body;
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        font-family: var(--font-sans, 'Inter', 'Noto Sans JP', -apple-system, sans-serif);
        background: radial-gradient(circle at 50% 18%, rgba(255,255,255,0.05), transparent 46%), var(--bg, #0B1020);
        color: var(--text, #f8fafc);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .quote-wrap {
        max-width: 82%;
        text-align: center;
      }
      .quote-mark {
        font-size: calc(var(--headline-size, 68px) * 1.4);
        line-height: 1;
        color: var(--kb-accent-blue, #60a5fa);
        font-weight: 800;
      }
      .quote-text {
        margin-top: 12px;
        font-size: var(--headline-size, 68px);
        line-height: 1.28;
        font-weight: 800;
        letter-spacing: -0.01em;
      }
      .quote-attribution {
        margin-top: 28px;
        font-size: var(--body-size, 23px);
        color: var(--subtext, #94a3b8);
        font-weight: 600;
      }
      .quote-rule {
        margin: 22px auto 0;
        width: 72px;
        height: 4px;
        border-radius: 2px;
        background: var(--kb-accent-blue, #60a5fa);
      }
    </style>
  </head>
  <body class="scene-${sanitizeCssClass(scene.template_id)} layout-${layoutVariant}">
    <div class="quote-wrap">
      <div class="quote-mark">&ldquo;</div>
      <div class="quote-text">${escapeHtml(title || '')}</div>
      <div class="quote-rule"></div>
      ${attribution ? `<div class="quote-attribution">${escapeHtml(attribution)}</div>` : ''}
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'logo-outro') {
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Outro</title>
    <style>
      ${sceneCssVars}
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        background:
          radial-gradient(circle at top, rgba(59,130,246,0.22), transparent 38%),
          linear-gradient(180deg, var(--bg, #050814) 0%, #0b1224 100%);
        color: var(--text, white);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-sans, 'Inter', sans-serif);
        overflow: hidden;
      }
      .center {
        text-align: center;
        
      }
      h1 { font-size: 80px; letter-spacing: -0.02em; margin: 0; font-weight: 900; }
      p { font-size: 24px; color: #64748b; margin-top: 20px; text-transform: uppercase; letter-spacing: 0.4em; }
      @keyframes scaleUp { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      .glow {
        position: absolute;
        width: 600px;
        height: 600px;
        background: radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%);
        z-index: -1;
      }
      .glow::after {
        content: '';
        position: absolute;
        inset: 120px;
        border-radius: 999px;
        border: 1px solid rgba(96,165,250,0.16);
        box-shadow: 0 0 120px rgba(96,165,250,0.12);
      }
    </style>
  </head>
  <body
    data-composition-id="${sceneKey}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${sceneKey}"
      data-width="${adf.composition.width}"
      data-height="${adf.composition.height}"
      data-duration="${scene.duration_sec}"
      data-start="0"
    >
    <div class="glow"></div>
    <div class="center">
      <h1>${escapeHtml(title || 'Kyberion')}</h1>
      <p>Initialize Your Mission.</p>
    </div>
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Scene</title>
    <style>
      ${sceneCssVars}
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        background: var(--bg, #070912);
        color: var(--text, white);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-sans, 'Inter', sans-serif);
        text-align: center;
      }
      .hero-text {
        
      }
      h1 { font-size: 96px; margin: 0; font-weight: 800; letter-spacing: -0.04em; }
      @keyframes reveal { from { opacity: 0; clip-path: inset(0 100% 0 0); } to { opacity: 1; clip-path: inset(0 0 0 0); } }
    </style>
  </head>
  <body
    data-composition-id="${sceneKey}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${sceneKey}"
      data-width="${adf.composition.width}"
      data-height="${adf.composition.height}"
      data-duration="${scene.duration_sec}"
      data-start="0"
    >
    <div class="hero-text">
      <h1>${escapeHtml(title || 'Kyberion')}</h1>
    </div>
    </div>
    ${hfScript}
  </body>
</html>`;
}

function renderBundleIndexHtml(plan: VideoCompositionRenderPlan, adf: VideoCompositionADF): string {
  const iframeContainers = plan.scenes
    .map((scene) => {
      const sceneKey = safeSceneKey(scene.scene_id);
      return `<iframe id="scene-frame-${sceneKey}" src="${scene.output_html}" style="position: absolute; top:0; left:0; width:100%; height:100%; border:none; display:none; overflow:hidden;" scrolling="no"></iframe>`;
    })
    .join('\n');
  const scenes = plan.scenes.map((scene) => ({
    scene_id: scene.scene_id,
    scene_key: safeSceneKey(scene.scene_id),
    start_sec: scene.start_sec,
    duration_sec: scene.duration_sec,
  }));

  const scriptContent = `
    const scenes = ${JSON.stringify(scenes)};

    function performSeek(time) {
      scenes.forEach((scene) => {
        const frame = document.getElementById("scene-frame-" + scene.scene_key);
        if (!frame) return;
        const relativeTime = time - scene.start_sec;
        if (time >= scene.start_sec && time < scene.start_sec + scene.duration_sec) {
          frame.style.display = "block";
          try {
            const win = frame.contentWindow;
            if (win && win.__timelines && win.__timelines[scene.scene_key]) {
              win.__timelines[scene.scene_key].seek(relativeTime);
            } else if (win && win.__hf && typeof win.__hf.seek === 'function') {
              win.__hf.seek(relativeTime);
            }
          } catch(e) {
            console.error("error seeking child iframe:", e);
          }
        } else {
          frame.style.display = "none";
        }
      });
    }

    const __hfTimeline = {
      duration: () => ${plan.duration_sec},
      time: () => 0,
      pause: () => {},
      play: () => {},
      seek: (time) => { performSeek(time); },
      totalTime: (time) => { performSeek(time); },
      isPlaying: () => false,
      setPlaybackRate: () => {},
      getPlaybackRate: () => 1,
    };
    window.__hf = {
      duration: ${plan.duration_sec},
      seek: (time) => { performSeek(time); }
    };
    window.__timelines = window.__timelines || {};
    window.__timelines["${plan.composition_id}"] = __hfTimeline;

    window.addEventListener('DOMContentLoaded', () => {
      performSeek(0);
    });
  `;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(plan.title)}</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: ${plan.width}px;
        height: ${plan.height}px;
        background: ${plan.background_color || '#09111f'};
        overflow: hidden;
      }
      #viewport {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
    </style>
  </head>
  <body data-composition-id="${plan.composition_id}" data-width="${plan.width}" data-height="${plan.height}" data-duration="${plan.duration_sec}" data-start="0">
    <div id="viewport" data-composition-id="${plan.composition_id}">
      ${iframeContainers}
    </div>
    <script>
      ${scriptContent}
    </script>
  </body>
</html>`;
}

function renderBundleReadme(plan: VideoCompositionRenderPlan, adf: VideoCompositionADF): string {
  return `# ${plan.title}

This bundle was generated from a governed \`video-composition-adf\`.

- Composition ID: \`${plan.composition_id}\`
- Duration: \`${plan.duration_sec}\` seconds
- FPS: \`${plan.fps}\`
- Resolution: \`${plan.width}x${plan.height}\`
- Output format target: \`${plan.output_format}\`
- Scene count: \`${plan.scenes.length}\`

Artifacts:

- \`index.html\`
- \`render-plan.json\`
- \`compositions/*.html\`

Audio references:

\`\`\`json
${JSON.stringify(adf.audio || {}, null, 2)}
\`\`\`

When backend rendering is enabled, narration is muxed into the final output artifact rather than left as a separate reference.
`;
}

function copySceneAssets(bundleDir: string, assetRefs: VideoCompositionAssetRef[]): void {
  const assetsDir = path.join(bundleDir, 'assets');
  safeMkdir(assetsDir, { recursive: true });
  for (const asset of assetRefs) {
    const sourcePath = pathResolver.rootResolve(asset.path);
    if (!safeExistsSync(sourcePath)) continue;
    const targetPath = path.resolve(assetsDir, safeAssetName(sourcePath));
    if (!safeExistsSync(targetPath)) {
      safeCopyFileSync(sourcePath, targetPath);
    }
  }
}

function buildDefaultBundleDir(adf: VideoCompositionADF, baseRoot: string): string {
  const baseName = slugify(adf.intent || adf.title || 'video-composition');
  return pathResolver.rootResolve(path.join(baseRoot, baseName));
}

function sceneText(scene: CompiledVideoCompositionScene, key: string): string {
  return String(scene.content?.[key] || '');
}

function sceneLayoutVariant(scene: CompiledVideoCompositionScene): string {
  return sanitizeCssClass(
    String(scene.content?.layout_variant || scene.content?.layout_family || 'default')
  );
}

function sceneThemeLayoutFamily(scene: CompiledVideoCompositionScene): string {
  return String(
    scene.content?.layout_family || scene.content?.layout_variant || scene.template_id || 'default'
  );
}

function sceneThemeMotionProfile(scene: CompiledVideoCompositionScene): string {
  return String(scene.content?.motion_profile || scene.content?.motion || 'guided-step');
}

function normalizeSceneDesignSystemVars(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, entry]) => {
      if (
        /^--kb-[a-z0-9-]+$/u.test(key) &&
        typeof entry === 'string' &&
        entry.trim() &&
        entry.length <= 512 &&
        !/[<>{};\u0000\r\n]/u.test(entry)
      ) {
        acc[key] = entry.trim();
      }
      return acc;
    },
    {}
  );
}

function buildSceneCssVars(
  scene: CompiledVideoCompositionScene,
  adf: VideoCompositionADF
): Record<string, string> {
  const designSystemVars = normalizeSceneDesignSystemVars(scene.content?.design_system_vars);
  const background =
    designSystemVars['--kb-bg-main'] ||
    designSystemVars['--bg'] ||
    adf.composition.background_color ||
    '#07111f';
  const themeVars = buildVideoDesignCssVars({
    backgroundColor: background,
    layoutFamily: sceneThemeLayoutFamily(scene),
    motionProfile: sceneThemeMotionProfile(scene),
    designSystemRef: { css_vars: designSystemVars } as any,
  });
  return {
    ...themeVars,
    '--bg': `var(--kb-bg-main, ${themeVars['--kb-bg-main'] || background})`,
    '--panel': `var(--kb-panel-bg, ${themeVars['--kb-panel-bg'] || 'rgba(15, 23, 42, 0.88)'})`,
    '--accent': `var(--kb-accent, ${themeVars['--kb-accent'] || '#60a5fa'})`,
    '--text': `var(--kb-text-primary, ${themeVars['--kb-text-primary'] || '#f8fafc'})`,
    '--subtext': `var(--kb-text-secondary, ${themeVars['--kb-text-secondary'] || '#94a3b8'})`,
    '--font-sans': `var(--kb-font-sans, ${themeVars['--kb-font-sans'] || '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'})`,
    '--headline-size': `var(--kb-size-headline, ${designSystemVars['--kb-size-headline'] || '68px'})`,
    '--body-size': `var(--kb-size-body, ${designSystemVars['--kb-size-body'] || '23px'})`,
    '--title-size': `var(--kb-size-title, ${designSystemVars['--kb-size-title'] || '42px'})`,
    '--label-size': `var(--kb-size-label, ${designSystemVars['--kb-size-label'] || '16px'})`,
    '--font-heading': `var(--kb-font-heading, ${designSystemVars['--kb-font-heading'] || '"Inter", sans-serif'})`,
    '--font-body': `var(--kb-font-body, ${designSystemVars['--kb-font-body'] || '"Inter", sans-serif'})`,
    '--space-unit': `var(--kb-space-unit, ${designSystemVars['--kb-space-unit'] || '4px'})`,
    '--safe-area': `var(--kb-safe-area, ${designSystemVars['--kb-safe-area'] || '5%'})`,
    '--radius-panel': `var(--kb-panel-radius, ${themeVars['--kb-panel-radius'] || '32px'})`,
    '--radius-surface': `var(--kb-surface-radius, ${themeVars['--kb-surface-radius'] || '24px'})`,
  };
}

function renderSceneCssVars(
  scene: CompiledVideoCompositionScene,
  adf: VideoCompositionADF
): string {
  const vars = extractSceneCssVars(scene, adf);
  const lines = Object.entries(vars)
    .map(([key, value]) => `      ${key}: ${value};`)
    .join('\n');
  return `:root {\n${lines}\n    }`;
}

function extractSceneCssVars(
  scene: CompiledVideoCompositionScene,
  adf: VideoCompositionADF
): Record<string, string> {
  return buildSceneCssVars(scene, adf);
}

function resolveAsset(
  assetRefs: VideoCompositionAssetRef[],
  role: VideoCompositionAssetRef['role']
): VideoCompositionAssetRef | undefined {
  return assetRefs.find((asset) => asset.role === role) || assetRefs[0];
}

function mergeSceneAssetRefs(
  declaredAssetRefs: VideoCompositionAssetRef[],
  inferredAssetRefs: VideoCompositionAssetRef[]
): VideoCompositionAssetRef[] {
  const seen = new Set<string>();
  const merged: VideoCompositionAssetRef[] = [];
  for (const asset of [...declaredAssetRefs, ...inferredAssetRefs]) {
    const key = `${asset.role || 'asset'}:${asset.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...asset });
  }
  return merged;
}

function extractAvatarAssetRefs(scene: VideoCompositionScene): VideoCompositionAssetRef[] {
  const avatarAssets = scene.content?.avatar_assets;
  if (!avatarAssets || typeof avatarAssets !== 'object') {
    return [];
  }
  return Object.entries(avatarAssets as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => ({
      asset_id: `${safeSceneKey(scene.scene_id)}-avatar-${safeSceneKey(key)}`,
      path: String(value),
      role: 'supporting' as const,
    }));
}

function resolveAvatarAsset(
  scene: CompiledVideoCompositionScene,
  supporting?: VideoCompositionAssetRef
): VideoCompositionAssetRef | undefined {
  const avatarAssets = scene.content?.avatar_assets;
  if (avatarAssets && typeof avatarAssets === 'object') {
    const variantKey = String(
      scene.content?.layout_variant || scene.content?.semantic || scene.role || ''
    ).toLowerCase();
    const candidate = [
      (avatarAssets as Record<string, unknown>)[variantKey],
      (avatarAssets as Record<string, unknown>)[scene.role as string],
      (avatarAssets as Record<string, unknown>)[
        String(scene.content?.semantic || '').toLowerCase()
      ],
      (avatarAssets as Record<string, unknown>)['default'],
    ].find((value) => typeof value === 'string' && value.trim());
    if (typeof candidate === 'string') {
      return {
        asset_id: `${safeSceneKey(scene.scene_id)}-avatar`,
        path: candidate,
        role: 'supporting',
      };
    }
  }
  return supporting;
}

function tokenizeVideoCss(css: string): string {
  // Typography follows the visual direction (portrait shorts need larger
  // type); colors below keep their historical token mapping.
  css = css
    .replace(/font-size:\s*68px/gi, 'font-size: var(--headline-size, 68px)')
    .replace(/font-size:\s*23px/gi, 'font-size: var(--body-size, 23px)');
  const tokenized = [
    { pattern: /#0B1020/gi, token: '--kb-bg-main' },
    { pattern: /#0b1224/gi, token: '--kb-bg-deep' },
    { pattern: /#09111f/gi, token: '--kb-bg-surface' },
    { pattern: /#07111f/gi, token: '--kb-bg-ink' },
    { pattern: /#070912/gi, token: '--kb-bg-surface-strong' },
    { pattern: /#060913/gi, token: '--kb-bg-canvas' },
    { pattern: /#050814/gi, token: '--kb-bg-deep-strong' },
    { pattern: /#050714/gi, token: '--kb-bg-deepest' },
    { pattern: /#93c5fd/gi, token: '--kb-accent-blue-soft' },
    { pattern: /#60a5fa/gi, token: '--kb-accent-blue' },
    { pattern: /#bfdbfe/gi, token: '--kb-accent-blue-text' },
    { pattern: /#cfe3ff/gi, token: '--kb-accent-blue-muted' },
    { pattern: /#f59e0b/gi, token: '--kb-accent-orange' },
    { pattern: /#fed7aa/gi, token: '--kb-accent-orange-muted' },
    { pattern: /#fecaca/gi, token: '--kb-danger-soft' },
    { pattern: /#f8fafc/gi, token: '--kb-text-primary' },
    { pattern: /#e2e8f0/gi, token: '--kb-text-secondary' },
    { pattern: /#cbd5e1/gi, token: '--kb-text-secondary' },
    { pattern: /#94a3b8/gi, token: '--kb-text-muted' },
    { pattern: /#64748b/gi, token: '--kb-text-subtle' },
    { pattern: /#22c55e/gi, token: '--kb-accent-green' },
    { pattern: /#bbf7d0/gi, token: '--kb-accent-green-muted' },
    { pattern: /#fff/gi, token: '--kb-text-inverse' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.1\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.12\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.15\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.16\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.18\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.2\s*\)/gi, token: '--kb-accent-blue-soft' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.22\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.24\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.28\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*59,\s*130,\s*246,\s*0\.34\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.12\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.16\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.18\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.22\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.28\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.44\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*96,\s*165,\s*250,\s*0\.6\s*\)/gi, token: '--kb-accent-blue-strong' },
    { pattern: /rgba\(\s*147,\s*197,\s*253,\s*0\s*\)/gi, token: '--kb-accent-blue-muted' },
    { pattern: /rgba\(\s*147,\s*197,\s*253,\s*0\.9\s*\)/gi, token: '--kb-accent-blue-muted' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.14\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.18\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.2\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*249,\s*115,\s*22,\s*0\.22\s*\)/gi, token: '--kb-accent-orange-soft' },
    { pattern: /rgba\(\s*245,\s*158,\s*11,\s*0\.42\s*\)/gi, token: '--kb-glow-warning' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.12\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.14\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.18\s*\)/gi, token: '--kb-accent-green-soft' },
    { pattern: /rgba\(\s*34,\s*197,\s*94,\s*0\.5\s*\)/gi, token: '--kb-glow-success' },
    { pattern: /rgba\(\s*220,\s*38,\s*38,\s*0\.2\s*\)/gi, token: '--kb-danger-soft' },
    { pattern: /rgba\(\s*248,\s*113,\s*113,\s*0\.2\s*\)/gi, token: '--kb-danger-soft' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.12\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.14\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.16\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*148,\s*163,\s*184,\s*0\.18\s*\)/gi, token: '--kb-border-subtle' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.82\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.86\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.88\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.9\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.92\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.95\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*15,\s*23,\s*42,\s*0\.96\s*\)/gi, token: '--kb-panel-bg' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.6\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.7\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.76\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.9\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*7,\s*17,\s*31,\s*0\.94\s*\)/gi, token: '--kb-bg-ink' },
    { pattern: /rgba\(\s*255,\s*255,\s*255,\s*0\.03\s*\)/gi, token: '--kb-overlay-light' },
    { pattern: /rgba\(\s*255,\s*255,\s*255,\s*0\.1\s*\)/gi, token: '--kb-overlay-heavy' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.24\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.25\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.3\s*\)/gi, token: '--kb-shadow-soft' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.35\s*\)/gi, token: '--kb-shadow-strong' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.45\s*\)/gi, token: '--kb-shadow-strong' },
    { pattern: /rgba\(\s*0,\s*0,\s*0,\s*0\.5\s*\)/gi, token: '--kb-shadow-strong' },
  ];
  return tokenized.reduce(
    (result, entry) => result.replace(entry.pattern, (match) => `var(${entry.token}, ${match})`),
    css
  );
}

function resolveAdfVisualDirection(adf: VideoCompositionADF): VideoVisualDirection {
  return normalizeVideoVisualDirection(adf.composition.visual_direction, {
    width: adf.composition.width,
    height: adf.composition.height,
  });
}

function resolveAdfMotionDirection(adf: VideoCompositionADF): VideoMotionDirection {
  return normalizeVideoMotionDirection(
    adf.composition.motion_direction,
    adf.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      role: scene.role,
      duration_sec: scene.duration_sec,
    }))
  );
}

/**
 * MP-02: scene templates are the scaffold; motion arrives as tokens.
 *
 * Each layer attaches to structural selectors the templates already ship, so
 * art direction can vary per story without the compiler carrying literal
 * `@keyframes`. A scene absent from the direction (or a template without the
 * hook element) simply renders without that layer.
 */
/**
 * MP-02: apply a model-composed arrangement to a scene.
 *
 * Opt-in — a composition is only applied when the ADF carries one, so existing
 * decks render byte-identically. The composition is re-normalized here against
 * the content the scene actually has, so a stored arrangement cannot outlive
 * the fields it was written for.
 */
function applySceneComposition(
  html: string,
  scene: CompiledVideoCompositionScene,
  compositions: SceneComposition[] | undefined
): string {
  if (!compositions?.length) return html;
  const drafted = compositions.find((entry) => entry.scene_id === scene.scene_id);
  if (!drafted) return html;

  const composition = normalizeSceneComposition(drafted, {
    scene_id: scene.scene_id,
    role: scene.role,
    available_keys: Object.keys(scene.content ?? {}).filter(
      (key) => scene.content[key] !== undefined && scene.content[key] !== null
    ),
  });

  const css = sceneCompositionToCss(composition);
  if (!css.trim()) return html;
  const block = `<style data-kb-composition="${escapeHtml(composition.layout)}">\n${css}\n</style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${block}\n</head>`)
    : `${block}\n${html}`;
}

function applySceneMotion(
  html: string,
  scene: CompiledVideoCompositionScene,
  direction: VideoMotionDirection
): string {
  const sceneMotion = direction.scenes.find((entry) => entry.scene_id === scene.scene_id);
  if (!sceneMotion) return html;
  const css = motionDirectionToCss({ scenes: [sceneMotion], transitions: [] }, undefined, {
    entrance: '.composition-root, body > .shell, body > .stack',
    layers: [
      'h1, .headline, .hero-text, .quote-text',
      '.visual, .panel, .process-visual, .proof-row, img',
    ],
  });
  if (!css.trim()) return html;
  const block = `<style data-kb-motion="${escapeHtml(sceneMotion.entrance.pattern_id)}">\n${css}\n</style>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${block}\n</head>`)
    : `${block}\n${html}`;
}

function applyVideoThemeTokens(html: string, direction?: VideoVisualDirection): string {
  const tokenized = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, css) => {
    return `<style${attrs}>${tokenizeVideoCss(css)}</style>`;
  });
  if (!direction) return tokenized;
  // The token pass rewrote hardcoded hexes to var(--kb-*); this :root block
  // gives those tokens story-specific values (falls back to legacy palette
  // when absent).
  const rootVars = `<style data-kb-visual-direction="${escapeHtml(direction.mood)}">\n${visualDirectionToCssVars(direction)}\n</style>`;
  return tokenized.includes('</head>')
    ? tokenized.replace('</head>', `${rootVars}\n</head>`)
    : `${rootVars}\n${tokenized}`;
}

function safeAssetName(assetPath: string): string {
  const fileName = path.basename(String(assetPath || '').trim());
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new Error(`Invalid asset path: ${assetPath}`);
  }
  return fileName;
}

function safeSceneKey(value: string): string {
  return slugify(String(value || 'scene'), { maxLength: 64, fallback: 'video-composition' });
}

function sanitizeCssClass(value: string): string {
  return safeSceneKey(value);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
