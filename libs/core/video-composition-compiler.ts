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
  const title = sceneText(scene, 'headline');
  const body = sceneText(scene, 'body');
  const eyebrow = sceneText(scene, 'eyebrow');
  const cta = sceneText(scene, 'cta');
  const statValue = sceneText(scene, 'stat_value');
  const statLabel = sceneText(scene, 'stat_label');
  const background = resolveAsset(scene.asset_refs, 'background') || resolveAsset(scene.asset_refs, 'hero');
  const supporting = resolveAsset(scene.asset_refs, 'hero') || resolveAsset(scene.asset_refs, 'supporting');
  const logo = resolveAsset(scene.asset_refs, 'logo');
  const backgroundColor = adf.composition.background_color || '#0B1020';

  if (scene.template_id === 'split-highlight') {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: ${backgroundColor};
        color: #f8fafc;
      }
      .stage {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
      }
      .copy {
        padding: 88px 72px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 20px;
      }
      .eyebrow { font-size: 18px; letter-spacing: 0.12em; text-transform: uppercase; color: #93c5fd; }
      h1 { margin: 0; font-size: 72px; line-height: 0.95; }
      p { margin: 0; font-size: 28px; line-height: 1.4; color: #cbd5e1; max-width: 720px; }
      .stat { display: flex; gap: 14px; align-items: baseline; }
      .stat strong { font-size: 44px; }
      .panel {
        margin: 48px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 28px;
        background: rgba(15, 23, 42, 0.82);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      }
      .panel img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .bg {
        position: absolute;
        inset: 0;
        background-image: ${background ? `url("${escapeHtml(background.path)}")` : 'none'};
        background-size: cover;
        background-position: center;
        opacity: 0.18;
        filter: blur(8px);
        transform: scale(1.08);
      }
    </style>
  </head>
  <body>
    <div class="bg"></div>
    <div class="stage">
      <section class="copy">
        ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
        <h1>${escapeHtml(title || 'Untitled Scene')}</h1>
        ${body ? `<p>${escapeHtml(body)}</p>` : ''}
        ${statValue ? `<div class="stat"><strong>${escapeHtml(statValue)}</strong><span>${escapeHtml(statLabel)}</span></div>` : ''}
        ${cta ? `<p>${escapeHtml(cta)}</p>` : ''}
      </section>
      <aside class="panel">
        ${supporting ? `<img src="${escapeHtml(supporting.path)}" alt="${escapeHtml(supporting.asset_id)}">` : `<div style="padding:32px;color:#94a3b8;">Add a hero or supporting asset to this scene.</div>`}
      </aside>
    </div>
  </body>
</html>`;
  }

  if (scene.template_id === 'logo-outro') {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 45%), ${backgroundColor};
        color: #f8fafc;
      }
      .wrap { display: flex; flex-direction: column; align-items: center; gap: 28px; text-align: center; padding: 48px; }
      img { max-width: 220px; max-height: 220px; object-fit: contain; }
      h1 { margin: 0; font-size: 68px; line-height: 0.95; }
      p { margin: 0; font-size: 24px; color: #cbd5e1; max-width: 860px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      ${logo ? `<img src="${escapeHtml(logo.path)}" alt="${escapeHtml(logo.asset_id)}">` : ''}
      <h1>${escapeHtml(title || 'Thank you')}</h1>
      ${body ? `<p>${escapeHtml(body)}</p>` : ''}
      ${cta ? `<p>${escapeHtml(cta)}</p>` : ''}
    </div>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title || scene.scene_id)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${adf.composition.width}px;
        height: ${adf.composition.height}px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: ${background ? `linear-gradient(rgba(11,16,32,0.48), rgba(11,16,32,0.82)), url("${escapeHtml(background.path)}") center/cover` : backgroundColor};
        color: #f8fafc;
      }
      .card {
        max-width: 1180px;
        padding: 72px 80px;
        border-radius: 32px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(15, 23, 42, 0.72);
        box-shadow: 0 30px 80px rgba(2, 6, 23, 0.35);
      }
      .eyebrow { font-size: 18px; letter-spacing: 0.14em; text-transform: uppercase; color: #93c5fd; margin-bottom: 20px; }
      h1 { margin: 0; font-size: 84px; line-height: 0.94; }
      p { margin: 18px 0 0; font-size: 28px; line-height: 1.45; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="card">
      ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
      <h1>${escapeHtml(title || 'Untitled Scene')}</h1>
      ${body ? `<p>${escapeHtml(body)}</p>` : ''}
      ${cta ? `<p>${escapeHtml(cta)}</p>` : ''}
    </div>
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
  <body>
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
