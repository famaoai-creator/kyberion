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
  const bundleDir = path.resolve(process.cwd(), options?.bundleDir || adf.output.bundle_dir || buildDefaultBundleDir(adf, policy.bundle.default_bundle_root));
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
    artifactRefs.push(path.resolve(process.cwd(), adf.audio.narration_ref));
  }

  return {
    kind: 'video-composition-render-plan',
    version: adf.version,
    composition_id: compositionId,
    source_kind: 'video-composition-adf',
    title: adf.title || adf.intent || 'Kyberion Video Composition',
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
  const hfScript = `<script>
  window.__hf = {
    duration: ${scene.duration_sec},
    seek: (time) => { console.log('[HF] seek', time); }
  };
</script>`;

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
        animation: fadeIn 0.8s ease-out;
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
        animation: zoomIn 10s infinite alternate;
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
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}">
    <div class="grid"></div>
    <div class="container">
      <div class="content">
        ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
        <h1>${escapeHtml(title || 'Mission Logic')}</h1>
        <div class="body">${escapeHtml(body)}</div>
      </div>
      <div class="visual">
        ${supporting ? `<img src="${escapeHtml(supporting.path)}" alt="visual">` : '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.2)">[Architecture Vision]</div>'}
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
        background: #000;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Inter', sans-serif;
        overflow: hidden;
      }
      .center {
        text-align: center;
        animation: scaleUp 1.2s cubic-bezier(0.16, 1, 0.3, 1);
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
    </style>
  </head>
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}">
    <div class="glow"></div>
    <div class="center">
      <h1>${escapeHtml(title || 'Kyberion')}</h1>
      <p>Initialize Your Mission.</p>
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
        animation: reveal 1.5s cubic-bezier(0.77, 0, 0.175, 1);
      }
      h1 { font-size: 96px; margin: 0; font-weight: 800; letter-spacing: -0.04em; }
      @keyframes reveal { from { opacity: 0; clip-path: inset(0 100% 0 0); } to { opacity: 1; clip-path: inset(0 0 0 0); } }
    </style>
  </head>
  <body data-composition-id="${scene.scene_id}" data-width="${adf.composition.width}" data-height="${adf.composition.height}">
    <div class="hero-text">
      <h1>${escapeHtml(title || 'Kyberion')}</h1>
    </div>
    ${hfScript}
  </body>
</html>`;
}

function renderBundleIndexHtml(plan: VideoCompositionRenderPlan, adf: VideoCompositionADF): string {
  const sceneLinks = plan.scenes
    .map((scene) => `<li><a href="${escapeHtml(scene.output_html)}">${escapeHtml(scene.scene_id)}</a> <span>${scene.start_sec.toFixed(2)}s - ${(scene.start_sec + scene.duration_sec).toFixed(2)}s</span></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(plan.title)}</title>
    <style>
      body {
        margin: 0;
        padding: 40px;
        background: #09111f;
        color: #e2e8f0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .shell { max-width: 1080px; margin: 0 auto; }
      h1 { margin-bottom: 8px; }
      .meta { color: #94a3b8; margin-bottom: 32px; }
      ul { padding-left: 20px; }
      li { margin: 10px 0; }
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
  <body data-composition-id="${plan.composition_id}" data-width="${plan.width}" data-height="${plan.height}">
    <div class="shell">
      <h1>${escapeHtml(plan.title)}</h1>
      <div class="meta">${plan.width}x${plan.height} • ${plan.fps}fps • ${plan.duration_sec}s • ${escapeHtml(plan.output_format)}</div>
      <p>This bundle contains governed composed-video source artifacts prepared by Kyberion. The generated scene HTML files are deterministic input artifacts for a future renderer backend.</p>
      <ul>
        ${sceneLinks}
      </ul>
      <div class="note">
        <strong>Audio refs:</strong> <code>${escapeHtml(JSON.stringify(adf.audio || {}, null, 0))}</code>
      </div>
    </div>
    <script>
      window.__hf = {
        duration: ${plan.duration_sec},
        seek: (time) => { console.log('[HF] root seek to', time); }
      };
      window.__timelines = {
        "${plan.composition_id}": { duration: ${plan.duration_sec} }
      };
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
`;
}

function copySceneAssets(bundleDir: string, assetRefs: VideoCompositionAssetRef[]): void {
  const assetsDir = path.join(bundleDir, 'assets');
  safeMkdir(assetsDir, { recursive: true });
  for (const asset of assetRefs) {
    const sourcePath = path.resolve(process.cwd(), asset.path);
    if (!safeExistsSync(sourcePath)) continue;
    const fileName = path.basename(sourcePath);
    const targetPath = path.join(assetsDir, fileName);
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
