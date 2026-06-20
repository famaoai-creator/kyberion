import * as path from 'node:path';
import { getVideoCompositionTemplateRecord } from './video-composition-template-registry.js';
import { getVideoRenderRuntimePolicy } from './video-render-runtime-policy.js';
import * as pathResolver from './path-resolver.js';
import { safeCopyFileSync, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type {
  CompiledVideoCompositionScene,
  VideoCompositionADF,
  VideoCompositionAssetRef,
  VideoCompositionRenderPlan,
  VideoCompositionScene,
} from './video-composition-contract.js';

export function compileVideoCompositionADF(adf: VideoCompositionADF, options?: { bundleDir?: string }): VideoCompositionRenderPlan {
  const policy = getVideoRenderRuntimePolicy();
  const bundleDir = pathResolver.rootResolve(options?.bundleDir || adf.output.bundle_dir || buildDefaultBundleDir(adf, policy.bundle.default_bundle_root));
  const compositionId = slugify(adf.intent || adf.title || 'video-composition');
  const backgroundColor = adf.composition.background_color || '#0B1020';

  if (!policy.render.allowed_output_formats.includes(adf.output.format)) {
    throw new Error(`Unsupported composed-video output format: ${adf.output.format}`);
  }

  const compiledScenes = adf.scenes
    .slice()
    .sort((a, b) => a.start_sec - b.start_sec)
    .map((scene) => compileScene(scene, adf));

  const endTime = compiledScenes.reduce((max, scene) => Math.max(max, scene.start_sec + scene.duration_sec), 0);
  if (endTime > adf.composition.duration_sec + 0.0001) {
    throw new Error(`Scene timings exceed composition duration (${endTime}s > ${adf.composition.duration_sec}s)`);
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
    narration_ref: adf.audio?.narration_ref ? pathResolver.rootResolve(adf.audio.narration_ref) : undefined,
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
  options?: { bundleDir?: string },
): VideoCompositionRenderPlan {
  const policy = getVideoRenderRuntimePolicy();
  const plan = compileVideoCompositionADF(adf, options);
  safeMkdir(plan.bundle_dir, { recursive: true });
  safeMkdir(path.join(plan.bundle_dir, 'compositions'), { recursive: true });

  for (const scene of plan.scenes) {
    const sceneSource = renderSceneHtml(adf, scene);
    const scenePath = path.join(plan.bundle_dir, scene.output_html);
    safeWriteFile(scenePath, sceneSource);

    if (policy.bundle.copy_declared_assets) {
      copySceneAssets(plan.bundle_dir, scene.asset_refs);
    }
  }

  safeWriteFile(plan.index_html, renderBundleIndexHtml(plan, adf));
  safeWriteFile(path.join(plan.bundle_dir, 'render-plan.json'), JSON.stringify(plan, null, 2));
  safeWriteFile(path.join(plan.bundle_dir, 'README.md'), renderBundleReadme(plan, adf));

  return plan;
}

function compileScene(scene: VideoCompositionScene, adf: VideoCompositionADF): CompiledVideoCompositionScene {
  const template = getVideoCompositionTemplateRecord(scene.template_ref?.template_id);
  const role = scene.role || 'generic';
  if (template.status !== 'active') {
    throw new Error(`Template ${template.template_id} is not active`);
  }
  if (!template.supported_roles.includes(role)) {
    throw new Error(`Template ${template.template_id} does not support scene role ${role}`);
  }
  if (!template.supported_output_formats.includes(adf.output.format)) {
    throw new Error(`Template ${template.template_id} does not support output format ${adf.output.format}`);
  }
  for (const field of template.required_content_fields) {
    const value = scene.content?.[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Scene ${scene.scene_id} is missing required content field "${field}" for template ${template.template_id}`);
    }
  }

  return {
    scene_id: scene.scene_id,
    role,
    start_sec: scene.start_sec,
    duration_sec: scene.duration_sec,
    template_id: template.template_id,
    template_display_name: template.display_name,
    output_html: path.join('compositions', `${scene.scene_id}.html`),
    required_content_fields: template.required_content_fields,
    content: { ...scene.content },
    asset_refs: (scene.asset_refs || []).map((asset) => ({ ...asset })),
  };
}

function renderSceneHtml(adf: VideoCompositionADF, scene: CompiledVideoCompositionScene): string {
  // Templates declare `headline` (and sometimes `title`) as the
  // canonical content field — basic-title-card / split-highlight both
  // ship `headline` in their `required_content_fields`. Older ADFs
  // wrote `title` directly, so we accept either to keep both shapes
  // working.
  const title = sceneText(scene, 'headline') || sceneText(scene, 'title');
  const body = sceneText(scene, 'body');
  const eyebrow = sceneText(scene, 'eyebrow');
  const supporting = resolveAsset(scene.asset_refs, 'supporting');
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
            ? visualSteps.map((step: any, index: number) => `
              <div class="process-step">
                <span>${escapeHtml(step.step)}</span>
                <strong>${escapeHtml(step.detail)}</strong>
                <small>${escapeHtml(sceneText(scene, 'caption') || sceneText(scene, 'body') || `Beat ${index + 1}`)}</small>
              </div>
              ${index < visualSteps.length - 1 ? '<div class="process-arrow"></div>' : ''}
            `).join('')
            : `
              <div class="process-step">
                <span>01</span>
                <strong>Brief intake</strong>
                <small>Audience, use case, constraints</small>
              </div>
              <div class="process-arrow"></div>
              <div class="process-step">
                <span>02</span>
                <strong>Content plan</strong>
                <small>Hook, scene order, required copy</small>
              </div>
              <div class="process-arrow"></div>
              <div class="process-step">
                <span>03</span>
                <strong>Render package</strong>
                <small>Bundle, narration, mp4 output</small>
              </div>
            `
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
  window.__timelines["${scene.scene_id}"] = __hfTimeline;
</script>`;

  if (scene.template_id === 'howto-guide') {
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      :root {
        --bg: #07111f;
        --panel: rgba(15, 23, 42, 0.88);
        --accent: #60a5fa;
        --text: #f8fafc;
        --subtext: #94a3b8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
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
        color: #93c5fd;
        margin-bottom: 18px;
      }
      .eyebrow::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #60a5fa;
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
        color: #bfdbfe;
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
        color: #cfe3ff;
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
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
      <div class="frame">
        <div>
          ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
          <h1>${escapeHtml(title || 'How-to')}</h1>
          <div class="body">${escapeHtml(body)}</div>
          <div class="summary">
            ${(Array.isArray(scene.content.visual_steps) ? scene.content.visual_steps : []).slice(0, 4).map((step: any) => `<div class="pill">${escapeHtml(String(step.step ?? ''))} ${escapeHtml(String(step.detail ?? ''))}</div>`).join('')}
          </div>
        </div>
        <div class="visual">
          ${supporting ? `<img src="${escapeHtml(supporting.path)}" alt="visual">` : `
            <div class="fallback">
              <h2>Ordered steps</h2>
              <p>${escapeHtml(sceneText(scene, 'caption') || 'Audience, use case, constraints, and render output are sequenced as a governed flow.')}</p>
            </div>
          `}
        </div>
      </div>
    </div>
    ${hfScript}
  </body>
</html>`;
  }

  if (scene.template_id === 'promo-spot') {
    const valuePoints = Array.isArray(scene.content.value_points) ? scene.content.value_points.map((value: any) => String(value)).filter(Boolean) : [];
    const proofPoints = Array.isArray(scene.content.social_proof) ? scene.content.social_proof.map((value: any) => String(value)).filter(Boolean) : [];
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        background: radial-gradient(circle at top right, rgba(249,115,22,0.18), transparent 30%), #060913;
        color: white;
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
        color: #f59e0b;
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
      .metric span { display: block; color: #f59e0b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.18em; margin-bottom: 8px; }
      .metric strong { font-size: 22px; line-height: 1.15; }
      @keyframes pulse { from { transform: translateY(0); } to { transform: translateY(-6px); } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
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
    const chatMessages = Array.isArray(scene.content.chat_messages) ? scene.content.chat_messages : [];
    const stageNotes = Array.isArray(scene.content.stage_notes) ? scene.content.stage_notes : [];
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(34,197,94,0.14), transparent 24%),
          radial-gradient(circle at bottom right, rgba(59,130,246,0.18), transparent 28%),
          #050714;
        color: white;
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
      .avatar {
        border-radius: 32px;
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
        color: #93c5fd;
      }
      .persona-line::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 16px rgba(34,197,94,0.5);
      }
      .panel {
        border-radius: 32px;
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
        color: #93c5fd;
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
        color: #bbf7d0;
        border: 1px solid rgba(34,197,94,0.18);
        font-size: 14px;
      }
      @keyframes breathe { from { transform: scale(1); } to { transform: scale(1.02); } }
      .avatar-circle { animation: breathe 4s ease-in-out infinite alternate; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
    <div class="composition-root" data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}" data-duration="${scene.duration_sec}" data-start="0">
      <div class="stage">
        <div class="avatar">
          <div class="avatar-circle">${escapeHtml((eyebrow || 'K').slice(0, 1))}</div>
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
    ${hfScript}
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
      :root { 
        --bg: #070912;
        --accent: #3b82f6;
        --text: #f8fafc;
        --subtext: #94a3b8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
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
        color: #93c5fd;
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
    data-composition-id="${scene.scene_id}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${scene.scene_id}"
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

  if (scene.template_id === 'logo-outro') {
    return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Outro</title>
    <style>
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        background:
          radial-gradient(circle at top, rgba(59,130,246,0.22), transparent 38%),
          linear-gradient(180deg, #050814 0%, #0b1224 100%);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Inter', sans-serif;
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
    data-composition-id="${scene.scene_id}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${scene.scene_id}"
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
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        background: #070912;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Inter', sans-serif;
        text-align: center;
      }
      .hero-text {
        
      }
      h1 { font-size: 96px; margin: 0; font-weight: 800; letter-spacing: -0.04em; }
      @keyframes reveal { from { opacity: 0; clip-path: inset(0 100% 0 0); } to { opacity: 1; clip-path: inset(0 0 0 0); } }
    </style>
  </head>
  <body
    data-composition-id="${scene.scene_id}"
    data-width="${adf.composition.width}"
    data-height="${adf.composition.height}"
    data-duration="${scene.duration_sec}"
    data-start="0"
  >
    <div
      class="composition-root"
      data-composition-id="${scene.scene_id}"
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
  const presentationMode = String(plan.scenes[0]?.content?.presentation_mode || 'howto');
  const sceneCards = plan.scenes
    .map((scene, index) => {
      const ordinal = String(index + 1).padStart(2, '0');
      const range = `${scene.start_sec.toFixed(2)}s - ${(scene.start_sec + scene.duration_sec).toFixed(2)}s`;
      return `<article class="scene-card">
        <div class="scene-card__ordinal">${ordinal}</div>
        <div class="scene-card__body">
          <div class="scene-card__title">${escapeHtml(scene.scene_id)}</div>
          <div class="scene-card__meta">${escapeHtml(scene.template_display_name)} • ${range}</div>
        </div>
      </article>`;
    })
    .join('\n');
  const processSteps = (presentationMode === 'promo'
    ? [
        { title: 'Value spike', body: 'Lead with the promise and the strongest benefit.' },
        { title: 'Proof block', body: 'Back the promise with evidence, references, and outcome cards.' },
        { title: 'CTA lockup', body: 'End with a decisive action and clear next step.' },
      ]
    : presentationMode === 'vtuber'
      ? [
          { title: 'On-air cue', body: 'Open with the live persona and immediate viewer context.' },
          { title: 'Persona beat', body: 'Show the character, voice, and community-facing tone.' },
          { title: 'Live demo', body: 'Demonstrate the action with chat and stage framing.' },
        ]
      : [
          {
            title: 'Brief intake',
            body: 'Audience, use case, and constraints are already decided before production starts.',
          },
          {
            title: 'Content plan',
            body: 'The agreed brief is translated into hook, feature, and outro content.',
          },
          {
            title: 'Render package',
            body: 'The governed bundle is rendered and muxed into the final mp4 artifact.',
          },
        ])
    .map((step, index) => `<div class="process-step">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <strong>${escapeHtml(step.title)}</strong>
      <small>${escapeHtml(step.body)}</small>
    </div>`).join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(plan.title)}</title>
    <style>
      body {
        margin: 0;
        padding: 48px;
        background: #09111f;
        color: #e2e8f0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .shell { max-width: 1180px; margin: 0 auto; }
      .hero {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 28px;
        align-items: start;
      }
      h1 { margin: 0 0 10px 0; font-size: 58px; line-height: 1.02; letter-spacing: -0.04em; }
      .meta { color: #94a3b8; margin-bottom: 20px; }
      .mode-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        margin-bottom: 18px;
        background: rgba(59,130,246,0.12);
        border: 1px solid rgba(59,130,246,0.16);
        color: #bfdbfe;
        font-size: 13px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .mode-badge::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #60a5fa;
      }
      .lede {
        margin: 0 0 28px 0;
        font-size: 18px;
        line-height: 1.7;
        color: #cbd5e1;
        max-width: 760px;
      }
      .process {
        display: grid;
        gap: 14px;
        padding: 22px;
        border-radius: 24px;
        background: rgba(15,23,42,0.92);
        border: 1px solid rgba(148,163,184,0.16);
        box-shadow: 0 30px 80px rgba(0,0,0,0.28);
      }
      .process-step {
        display: grid;
        grid-template-columns: 56px 1fr;
        gap: 14px;
        align-items: center;
        padding: 16px 18px;
        border-radius: 18px;
        background: rgba(7, 17, 31, 0.72);
        border: 1px solid rgba(148,163,184,0.12);
      }
      .process-step span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: 16px;
        background: rgba(59,130,246,0.16);
        color: #93c5fd;
        font-weight: 800;
        letter-spacing: 0.08em;
      }
      .process-step strong { font-size: 18px; display: block; margin-bottom: 2px; }
      .process-step small { color: #94a3b8; line-height: 1.5; }
      .scene-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin-top: 26px;
      }
      .scene-card {
        display: flex;
        gap: 14px;
        padding: 18px;
        border-radius: 20px;
        background: rgba(15,23,42,0.88);
        border: 1px solid rgba(148,163,184,0.16);
      }
      .scene-card__ordinal {
        width: 44px;
        height: 44px;
        border-radius: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(96,165,250,0.14);
        color: #bfdbfe;
        font-weight: 800;
      }
      .scene-card__title { font-weight: 700; margin-bottom: 3px; }
      .scene-card__meta { color: #94a3b8; font-size: 14px; line-height: 1.5; }
      a { color: #93c5fd; }
      code { color: #cbd5e1; }
      .note {
        margin-top: 32px;
        padding: 16px 20px;
        border-radius: 14px;
        background: rgba(15,23,42,0.92);
        border: 1px solid rgba(148,163,184,0.2);
      }
    </style>
  </head>
  <body
    data-composition-id="${plan.composition_id}"
    data-width="${plan.width}"
    data-height="${plan.height}"
    data-duration="${plan.duration_sec}"
    data-start="0"
  >
    <div
      class="shell"
      data-composition-id="${plan.composition_id}"
      data-width="${plan.width}"
      data-height="${plan.height}"
      data-duration="${plan.duration_sec}"
      data-start="0"
    >
      <div class="hero">
        <div>
          <div class="mode-badge">${escapeHtml(presentationMode)}</div>
          <h1>${escapeHtml(plan.title)}</h1>
          <div class="meta">${plan.width}x${plan.height} • ${plan.fps}fps • ${plan.duration_sec}s • ${escapeHtml(plan.output_format)} • mode ${escapeHtml(presentationMode)}</div>
          <p class="lede">This bundle is the render-ready output of a fixed brief. The content is not a generic product pitch: it is a deterministic transformation from approved audience and messaging inputs into a narrated scene plan.</p>
          <div class="scene-grid">
            ${sceneCards}
          </div>
        </div>
        <div class="process">
          ${processSteps}
        </div>
      </div>
      <div class="note">
        <strong>Audio refs:</strong> <code>${escapeHtml(JSON.stringify(adf.audio || {}, null, 0))}</code><br>
        When backend rendering is enabled, narration will be muxed into the final output artifact.
      </div>
    </div>
    <script>
      const __hfTimeline = {
        duration: () => ${plan.duration_sec},
        time: () => 0,
        pause: () => {},
        play: () => {},
        seek: (time) => { console.log('[HF] root seek to', time); },
        totalTime: (time) => { console.log('[HF] root totalTime to', time); },
        isPlaying: () => false,
        setPlaybackRate: () => {},
        getPlaybackRate: () => 1,
      };
      window.__hf = {
        duration: ${plan.duration_sec},
        seek: (time) => { console.log('[HF] root seek to', time); }
      };
      window.__timelines = window.__timelines || {};
      window.__timelines["${plan.composition_id}"] = __hfTimeline;
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

function resolveAsset(assetRefs: VideoCompositionAssetRef[], role: VideoCompositionAssetRef['role']): VideoCompositionAssetRef | undefined {
  return assetRefs.find((asset) => asset.role === role) || assetRefs[0];
}

function safeAssetName(assetPath: string): string {
  const fileName = path.basename(String(assetPath || '').trim());
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new Error(`Invalid asset path: ${assetPath}`);
  }
  return fileName;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'video-composition';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
