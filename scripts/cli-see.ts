import type { Observation } from '@agent/core/perception/observation';
import {
  PERCEPTION_OPTIONS_HELP,
  validatePerceptionOptions,
  enhancementDeps,
  renderObservations,
} from './lib/perception-enhancements.js';
/**
 * `pnpm kyberion see <image> [--describe] [--lang <bcp47>] [--json] [--out <file>]`
 *
 * The one-line way for any agent to read the text in an image through the
 * governed OCR bridge (@agent/core/ocr-bridge) instead of improvising a
 * tesseract / Vision script. OCR runs with `mode: 'local_only'` — the image
 * never leaves the machine. `--describe` additionally asks the image
 * description bridge for a caption and says which provider served it.
 *
 * Inputs must live inside the repository (same boundary as `kyberion read`).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
  assertPerceptionInput,
  defaultPerceptionDeps,
  emitOutput,
  IMAGE_EXTENSIONS,
  parseCommonOption,
  resolveRepositoryInput,
  sniffImageDimensions,
  type CommonArgs,
  type PerceptionDeps,
} from './lib/perception.js';

export const SEE_USAGE = `Usage: pnpm kyberion see <image> [--describe] [--no-ocr] [--provider <id>] [--lang <bcp47>] [--json] [--out <file>]

Reads the text in a ${IMAGE_EXTENSIONS.join(' / ')} image with local OCR (no data egress) and prints Markdown.
  --describe     Also caption the image via the image description bridge (provider noted in the output)
  --no-ocr       Skip OCR (use with --describe for image captioning only)
  --provider <id> Prefer an OCR provider (e.g. local_vlm); allows loopback OCR, never external OCR
  --lang <tag>   OCR language hint, e.g. ja, en, ja+en
  --timeout-ms <ms>  OCR deadline (default 120000)
  --json         Print {file, bytes, width, height, ocr, description, warnings} as JSON
  --out <file>   Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose      Keep runtime logs (they go to stdout; off by default so stdout is the content)

${PERCEPTION_OPTIONS_HELP}

The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<image> active/shared/tmp/<job>/`;

interface SeeArgs extends CommonArgs {
  describe: boolean;
  timeoutMs?: number;
  provider?: string;
  ocr: boolean;
}

export interface SeeResult {
  source?: import('@agent/core/perception/observation').PerceptionSource;
  observations?: Observation[];
  changes?: import('@agent/core/perception/visual-change').VisualChange;
  tracking?: import('@agent/core/perception/tracking').TrackingResult;
  animation_cues?: unknown[];
  index?: unknown;
  search?: import('@agent/core/perception/semantic-index').SemanticSearchHit[];
  file: string;
  bytes: number;
  width?: number;
  height?: number;
  ocr?: { text: string; provider: string; confidence: number; data_egress?: string };
  description?: { text: string; provider: string };
  warnings: string[];
}

function parseSeeArgs(argv: string[]): SeeArgs {
  const args: SeeArgs = { json: false, help: false, describe: false, ocr: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    if (value === '--timeout-ms') {
      const timeout = Number(argv[++index]);
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new ScriptExitError(1, '--timeout-ms requires a positive number');
      args.timeoutMs = timeout;
    } else if (value === '--provider') {
      args.provider = argv[++index];
      if (!args.provider) throw new ScriptExitError(1, '--provider requires an id');
    } else if (value === '--describe') args.describe = true;
    else if (value === '--no-ocr') args.ocr = false;
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

export function renderSeeResult(result: SeeResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  if (result.search)
    return [
      '# Semantic search',
      '',
      ...result.search.map(
        (hit) =>
          '- ' +
          hit.path +
          (hit.time_sec === undefined ? '' : ' @ ' + hit.time_sec + 's') +
          ' (score ' +
          hit.score.toFixed(4) +
          ')'
      ),
      ...(result.search.length ? [] : ['_(no matches)_']),
    ].join('\n');
  const dims = result.width && result.height ? `, ${result.width}×${result.height}` : '';
  const lines = [
    `# ${path.basename(result.file)}`,
    '',
    `- file: ${result.file} (${result.bytes} bytes${dims})`,
  ];
  if (result.ocr) {
    lines.push(
      `- ocr: ${result.ocr.provider} (confidence ${Math.round(result.ocr.confidence)}, egress ${result.ocr.data_egress ?? 'none'})`
    );
  }
  if (result.description) lines.push('', '## Description', '', result.description.text.trim());
  lines.push('', '## Text', '', result.ocr?.text.trim() || '_(no text recognized)_');
  if (result.changes) lines.push('', '## Changes', '', JSON.stringify(result.changes));
  if (result.tracking) lines.push('', '## Tracking', '', JSON.stringify(result.tracking));
  if (result.index) lines.push('', '## Index', '', JSON.stringify(result.index));
  if (result.search) lines.push('', '## Search', '', JSON.stringify(result.search, null, 2));
  if (result.observations) lines.push(...renderObservations(result.observations));
  if (result.warnings.length > 0) lines.push('', ...result.warnings.map((w) => `> [see] ${w}`));
  return lines.join('\n');
}

export async function runSeeCommand(
  argv: string[],
  print: (text: string) => void,
  deps: PerceptionDeps = defaultPerceptionDeps
): Promise<SeeResult | undefined> {
  const args = parseSeeArgs(argv);
  if (args.help || (!args.file && !args.enhancement?.search)) {
    if (!args.file && !args.help) throw new ScriptExitError(1, SEE_USAGE);
    print(SEE_USAGE);
    return undefined;
  }
  const options = args.enhancement ?? {};
  validatePerceptionOptions('see', options);
  if (options.search) {
    if (args.file) throw new ScriptExitError(1, '--search does not take an input file');
    const { resolveScopeContext } = await import('@agent/core/scope-context');
    const current = resolveScopeContext();
    const search =
      deps.enhancements?.search ??
      (await import('@agent/core/perception/semantic-index')).searchMedia;
    const hits = await search({
      indexId: options.index!,
      scope: {
        tier: current.tier,
        ...(current.tenant_slug ? { tenant_slug: current.tenant_slug } : {}),
      },
      query: options.search,
      modelPath: options.embeddingModel!,
      python: options.python,
    });
    const result: SeeResult = { file: '', bytes: 0, search: hits, warnings: [] };
    emitOutput('see', renderSeeResult(result, args.json), args.out, print, 'semantic search');
    return result;
  }
  const absolute = resolveRepositoryInput('see', args.file!);
  assertExtension('see', absolute, IMAGE_EXTENSIONS);
  assertPerceptionInput(absolute);
  let buffer: Buffer;
  try {
    buffer = safeReadFile(absolute, { encoding: null }) as Buffer;
  } catch (error) {
    throw new ScriptExitError(1, `[see] cannot read ${args.file}: ${(error as Error).message}`);
  }
  const relative = path.relative(pathResolver.rootDir(), absolute);
  const result: SeeResult = {
    file: relative,
    bytes: buffer.length,
    ...sniffImageDimensions(buffer),
    warnings: [],
  };
  const enhanced = Boolean(options.grounded || options.compare || options.track || options.index);
  const feature = enhanced ? await enhancementDeps(deps) : undefined;
  const source = feature?.source?.(absolute) ?? feature?.perceptionSource(absolute);
  const previousSource =
    options.compare && feature
      ? feature.perceptionSource(resolveRepositoryInput('see', options.compare))
      : undefined;
  if (source) {
    result.source = source;
    result.observations = [];
  }
  if (args.ocr)
    try {
      const ocr = await deps.ocr({
        path: relative,
        mode: args.provider ? 'privacy_first' : 'local_only',
        ...(args.provider ? { providerPreference: [args.provider] } : {}),
        timeout_ms: args.timeoutMs,
        onProgress: (event) => {
          if (deps === defaultPerceptionDeps)
            process.stderr.write(
              `[see] OCR ${event.stage}${event.provider ? ` (${event.provider})` : ''}\n`
            );
        },
        ...(args.lang ? { language: args.lang } : {}),
      });
      if (source && feature)
        result.observations!.push(
          ...feature.ocrObservations(
            source,
            ocr,
            result.width && result.height
              ? { width: result.width, height: result.height }
              : undefined
          )
        );
      result.ocr = {
        text: ocr.text,
        provider: ocr.provider,
        confidence: ocr.confidence,
        ...(ocr.providerDataEgress ? { data_egress: ocr.providerDataEgress } : {}),
      };
    } catch (error) {
      result.warnings.push(`local OCR unavailable: ${(error as Error).message}`);
    }
  if (args.describe) {
    try {
      const description = await deps.describe({ path: relative, kind: 'detailed' });
      if (description.status === 'succeeded') {
        result.description = { text: description.description, provider: description.provider };
        if (source && feature)
          result.observations!.push(
            feature.observation(source, {
              modality: 'image',
              kind: 'description',
              provider: description.provider,
              finality: 'final',
              text: description.description,
            })
          );
        result.warnings.push(`description provided by ${description.provider}`);
      } else {
        result.warnings.push(
          `image description failed (${description.provider}): ${description.error ?? 'unknown'}`
        );
      }
    } catch (error) {
      result.warnings.push(`image description unavailable: ${(error as Error).message}`);
    }
  }
  if (options.compare && source && feature) {
    result.changes = await feature.compareImages(
      resolveRepositoryInput('see', options.compare),
      absolute
    );
    result.observations!.push(
      feature.observation(source, {
        modality: 'image',
        kind: 'visual_change',
        provider: 'local-pixel-delta',
        finality: 'final',
        attributes: { ...result.changes, previous_source: previousSource },
      })
    );
  }
  if (options.track) {
    const tracking = await import('@agent/core/perception/tracking');
    result.tracking = await (deps.enhancements?.track ?? tracking.trackMedia)({
      path: absolute,
      faceModel: options.faceModel,
      poseModel: options.poseModel,
      gestureModel: options.gestureModel,
      python: options.python,
      maxFrames: 1,
    });
    if (source)
      result.observations!.push(...tracking.trackingObservations(source, result.tracking));
    if (options.avatarId)
      result.animation_cues = result.tracking.frames.flatMap((frame) =>
        (deps.enhancements?.cues ?? tracking.trackingFrameToAnimationCues)(frame, options.avatarId!)
      );
  }
  if (options.index && source) {
    const index =
      deps.enhancements?.index ??
      (await import('@agent/core/perception/semantic-index')).indexMedia;
    result.index = await index({
      indexId: options.index,
      scope: source.scope,
      modelPath: options.embeddingModel!,
      python: options.python,
      entries: [
        {
          id: 'image',
          path: absolute,
          image_path: absolute,
          ...(result.ocr?.text?.trim() ? { text: result.ocr.text } : {}),
        },
      ],
    });
  }
  if (!result.ocr && !result.description && !result.tracking && !result.changes && !result.index) {
    throw new ScriptExitError(
      1,
      `[see] nothing could be read from ${args.file}: ${result.warnings.join('; ')}`
    );
  }
  if (source && feature) feature.assertSourceUnchanged(source);
  if (previousSource && feature) feature.assertSourceUnchanged(previousSource);
  const rendered = renderSeeResult(result, args.json);
  emitOutput('see', rendered, args.out, print, `${rendered.length} chars`, absolute);
  return result;
}
