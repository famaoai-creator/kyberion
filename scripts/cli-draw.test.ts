import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import type { ImageGenerationRequest } from '@agent/core/image-generation-types';
import {
  DRAW_HANDOFF_EXIT_CODE,
  DRAW_USAGE,
  runDrawCommand,
  summarizeProviderError,
  type DrawDeps,
  type DrawProviderInfo,
} from './cli-draw.js';
import type { MediaTool } from './lib/perception.js';

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

const PROVIDERS: DrawProviderInfo[] = [
  {
    id: 'apple_playground',
    displayName: 'Image Playground',
    dataEgress: 'local',
    interactiveHandoff: false,
  },
  { id: 'gemini_fast', displayName: 'Gemini', dataEgress: 'cloud', interactiveHandoff: false },
  {
    id: 'codex_host_bridge',
    displayName: 'Codex host bridge',
    dataEgress: 'cloud',
    interactiveHandoff: true,
  },
];

interface FakeDrawDeps extends DrawDeps {
  requests: ImageGenerationRequest[];
  plans: ImageGenerationRequest[];
  media: { tool: MediaTool; args: string[] }[];
}

/** Hermetic router stand-in: first available provider the request allows, preference first. */
function createFakeDrawDeps(
  options: {
    available?: string[];
    bytes?: Buffer;
    /** Write next to the target with this extension instead of at the target. */
    siblingExt?: string;
    generateError?: string;
  } = {}
): FakeDrawDeps {
  const available = options.available ?? ['apple_playground', 'gemini_fast', 'codex_host_bridge'];
  const requests: ImageGenerationRequest[] = [];
  const plans: ImageGenerationRequest[] = [];
  const media: { tool: MediaTool; args: string[] }[] = [];
  /** Pending host hand-offs by target, like libs/core/host-image-handoff.ts. */
  /** Host hand-off requests by target (prompt + file before the request), like libs/core/host-image-handoff.ts. */
  const handoffs = new Map<string, { prompt: string; prior: string | null }>();
  const contents = (file: string) =>
    safeExistsSync(file) ? String(safeReadFile(file, { encoding: 'utf8' })) : null;
  const pick = (request: ImageGenerationRequest) => {
    const order = [...(request.providerPreference ?? []), ...PROVIDERS.map((p) => p.id)];
    const id = order.find(
      (candidate) =>
        available.includes(candidate) && (request.allowedProviders ?? []).includes(candidate)
    );
    return PROVIDERS.find((p) => p.id === id);
  };
  return {
    requests,
    plans,
    media,
    async providers() {
      return PROVIDERS;
    },
    async plan(request) {
      plans.push({ ...request });
      const info = pick(request);
      if (!info) return null;
      return {
        provider_id: info.id,
        display_name: info.displayName,
        data_egress: info.dataEgress,
        requires_consent: info.dataEgress === 'cloud' && Boolean(request.referenceImages?.length),
        interactive_handoff: info.interactiveHandoff,
      };
    },
    async candidates(request) {
      return PROVIDERS.map((p) => ({
        id: p.id,
        eligible: false,
        unmet: (request.allowedProviders ?? []).includes(p.id) ? ['unavailable'] : ['not allowed'],
      }));
    },
    async generate(request) {
      requests.push(request);
      if (options.generateError) throw new Error(options.generateError);
      const info = pick(request)!;
      // Like the real host bridges: collect only a file changed since the request.
      const target = request.targetPath!;
      const pending = handoffs.get(target);
      if (
        info.interactiveHandoff &&
        contents(target) !== null &&
        pending?.prompt === request.prompt &&
        pending.prior !== contents(target)
      ) {
        return { status: 'succeeded', provider: info.id, path: target, elapsedMs: 1 };
      }
      if (info.interactiveHandoff) {
        if (pending?.prompt !== request.prompt) {
          handoffs.set(target, { prompt: request.prompt, prior: contents(target) });
        }
        throw new Error(
          `HOST_BRIDGE_IMAGE_GENERATION_REQUIRED: Codex host bridge is required. Please use your 'generate_image' tool.`
        );
      }
      const written = options.siblingExt ? target.replace(/\.[^.]+$/, options.siblingExt) : target;
      safeWriteFile(written, options.bytes ?? pngBytes(1024, 768));
      return { status: 'succeeded', provider: info.id, path: written, elapsedMs: 5 };
    },
    async consent(input) {
      return {
        subject: 'user_photo',
        provider_id: input.providerId,
        provider_class: 'cloud',
        granted_at: '2026-09-27T00:00:00.000Z',
        granted_by: input.grantedBy,
      };
    },
    async runMedia(tool, args) {
      media.push({ tool, args });
      safeWriteFile(args.at(-1)!, pngBytes(8, 8));
      return '';
    },
  };
}

describe('pnpm kyberion draw', () => {
  let workDir = '';
  let rel = (name: string) => name;
  let refPath = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`cli-draw-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    rel = (name: string) => path.relative(pathResolver.rootDir(), path.join(workDir, name));
    refPath = path.join(workDir, 'me.jpg');
    safeWriteFile(refPath, JPEG_BYTES);
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('draws with a local, unattended provider by default and reports egress', async () => {
    const deps = createFakeDrawDeps();
    const output: string[] = [];
    const result = await runDrawCommand(
      ['a', 'calm', 'lake', '--out', rel('lake.png'), '--aspect', '16:9'],
      (t) => output.push(t),
      deps
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      provider: 'apple_playground',
      data_egress: 'local',
      width: 1024,
      height: 768,
    });
    expect(deps.requests[0]).toMatchObject({
      prompt: 'a calm lake',
      mode: 'local_only',
      aspectRatio: '16:9',
      allowedProviders: ['apple_playground'],
    });
    expect(deps.requests[0]!.allowHostHandoff).toBeUndefined();
    expect(output.join('\n')).toContain('(apple_playground, egress local, 1024×768, 33 bytes)');
  });

  it('refuses cloud and hand-off without opt-in and says which flag allows them', async () => {
    const deps = createFakeDrawDeps({ available: ['gemini_fast', 'codex_host_bridge'] });
    await expect(runDrawCommand(['x', '--out', rel('a.png')], () => {}, deps)).rejects.toThrow(
      /no image provider[\s\S]*apple_playground: unavailable[\s\S]*--allow-cloud[\s\S]*--allow-handoff/
    );
    expect(deps.requests).toHaveLength(0);
  });

  it('uses a cloud provider under --allow-cloud and warns that the prompt left the machine', async () => {
    const deps = createFakeDrawDeps({ available: ['gemini_fast', 'codex_host_bridge'] });
    const output: string[] = [];
    const result = await runDrawCommand(
      ['x', '--out', rel('cloud.png'), '--allow-cloud', '--json'],
      (t) => output.push(t),
      deps
    );
    expect(result).toMatchObject({ provider: 'gemini_fast', data_egress: 'cloud' });
    expect(deps.requests[0]).toMatchObject({
      mode: 'balanced',
      allowedProviders: ['apple_playground', 'gemini_fast'],
    });
    expect(JSON.parse(output[0]!).warnings).toContain(
      'generated by Gemini: the prompt left this machine'
    );
  });

  it('keeps hand-off as a last resort: local wins, otherwise exit 100 with rerun instructions', async () => {
    const local = createFakeDrawDeps();
    await runDrawCommand(['x', '--out', rel('h1.png'), '--allow-handoff'], () => {}, local);
    expect(local.requests[0]).toMatchObject({ allowedProviders: ['apple_playground'] });

    const deps = createFakeDrawDeps({ available: ['codex_host_bridge'] });
    const output: string[] = [];
    const error = await runDrawCommand(
      ['x', '--out', rel('h2.png'), '--allow-handoff'],
      (t) => output.push(t),
      deps
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: DRAW_HANDOFF_EXIT_CODE, silent: true });
    expect(deps.requests[0]).toMatchObject({
      allowHostHandoff: true,
      allowedProviders: ['apple_playground', 'codex_host_bridge'],
    });
    expect(output.join('\n')).toMatch(
      /handoff \(codex_host_bridge\): HOST_BRIDGE_IMAGE_GENERATION_REQUIRED[\s\S]*rerun the same command/
    );
  });

  it('pins --provider: no silent fallback when it cannot run', async () => {
    const deps = createFakeDrawDeps({ available: ['apple_playground'] });
    await expect(
      runDrawCommand(
        ['x', '--out', rel('p.png'), '--allow-cloud', '--provider', 'gemini_fast'],
        () => {},
        deps
      )
    ).rejects.toThrow(/gemini_fast: unavailable/);
    const handoff = createFakeDrawDeps();
    await runDrawCommand(
      ['x', '--out', rel('p.png'), '--allow-handoff', '--provider', 'codex_host_bridge'],
      () => {},
      handoff
    ).catch(() => undefined);
    expect(handoff.requests[0]).toMatchObject({
      allowedProviders: ['codex_host_bridge'],
      allowHostHandoff: true,
    });
  });

  it('passes the hand-off through: a pre-existing --out is re-requested, the answer is collected', async () => {
    const out = rel('fox.png');
    const target = path.join(workDir, 'fox.png');
    safeWriteFile(target, pngBytes(8, 8));
    const argv = ['a', 'fox', '--out', out, '--allow-handoff'];
    const deps = createFakeDrawDeps({ available: ['codex_host_bridge'] });
    await expect(runDrawCommand(argv, () => {}, deps)).rejects.toMatchObject({
      code: DRAW_HANDOFF_EXIT_CODE,
    });
    safeWriteFile(target, pngBytes(64, 64));
    const collected = await runDrawCommand(argv, () => {}, deps);
    expect(collected).toMatchObject({
      status: 'succeeded',
      provider: 'codex_host_bridge',
      width: 64,
    });
    // Collection is idempotent; a different prompt needs a new host image.
    await expect(runDrawCommand(argv, () => {}, deps)).resolves.toMatchObject({
      status: 'succeeded',
    });
    await expect(
      runDrawCommand(['a', 'wolf', '--out', out, '--allow-handoff'], () => {}, deps)
    ).rejects.toMatchObject({ code: DRAW_HANDOFF_EXIT_CODE });
  });

  it('turns a dispatch-time consent denial into the consent hint', async () => {
    const deps = createFakeDrawDeps({
      generateError: '[IMAGE_REFERENCE_EGRESS_DENIED] gemini_image: consent names gemini_fast',
    });
    await expect(runDrawCommand(['x', '--out', rel('d.png')], () => {}, deps)).rejects.toThrow(
      /--consent-provider gemini_image --consent-granted-by <who>/
    );
  });

  it('prints the plan under --dry-run without generating (no --out needed)', async () => {
    const deps = createFakeDrawDeps({ available: ['gemini_fast'] });
    const output: string[] = [];
    const result = await runDrawCommand(
      [
        'x',
        '--allow-cloud',
        '--ref',
        `${path.relative(pathResolver.rootDir(), refPath)}:style`,
        '--dry-run',
      ],
      (t) => output.push(t),
      deps
    );
    expect(result?.status).toBe('planned');
    expect(deps.requests).toHaveLength(0);
    expect(deps.plans[0]!.referenceImages).toEqual([
      {
        path: path.relative(pathResolver.rootDir(), refPath),
        mimeType: 'image/jpeg',
        role: 'style',
      },
    ]);
    expect(output[0]).toBe(
      '[draw] plan: Gemini (gemini_fast), egress cloud, needs reference consent'
    );
  });

  it('requires a consent naming the cloud provider before sending reference images', async () => {
    const ref = path.relative(pathResolver.rootDir(), refPath);
    const deps = createFakeDrawDeps({ available: ['gemini_fast'] });
    await expect(
      runDrawCommand(['x', '--out', rel('r.png'), '--allow-cloud', '--ref', ref], () => {}, deps)
    ).rejects.toThrow(/--consent-provider gemini_fast --consent-granted-by <who>/);
    expect(deps.requests).toHaveLength(0);

    await runDrawCommand(
      [
        'x',
        '--out',
        rel('r.png'),
        '--allow-cloud',
        '--ref',
        ref,
        '--consent-provider',
        'gemini_fast',
        '--consent-granted-by',
        'user:me',
      ],
      () => {},
      deps
    );
    expect(deps.requests[0]!.egressConsent).toMatchObject({
      provider_id: 'gemini_fast',
      granted_by: 'user:me',
    });

    const local = createFakeDrawDeps();
    await runDrawCommand(['x', '--out', rel('r2.png'), '--ref', ref], () => {}, local);
    expect(local.requests[0]!.egressConsent).toBeUndefined();

    await expect(
      runDrawCommand(
        [
          'x',
          '--out',
          rel('r3.png'),
          '--ref',
          ref,
          '--consent-provider',
          'gemini_fast',
          '--consent-granted-by',
          'u',
        ],
        () => {},
        createFakeDrawDeps()
      )
    ).rejects.toThrow(/gemini_fast is not allowed for this run; add --allow-cloud/);
  });

  it('lands the image in the format --out names (sibling files and mismatched bytes)', async () => {
    const sibling = createFakeDrawDeps({ siblingExt: '.png' });
    const warnings = await runDrawCommand(['x', '--out', rel('photo.jpg')], () => {}, sibling);
    expect(sibling.media[0]!.args).toEqual(
      expect.arrayContaining(['-q:v', '2', path.join(workDir, 'photo.jpg')])
    );
    expect(safeExistsSync(path.join(workDir, 'photo.png'))).toBe(false);
    expect(warnings?.warnings).toContain('converted png → jpeg to match photo.jpg');

    const same = createFakeDrawDeps({ siblingExt: '.webp.png' });
    await runDrawCommand(['x', '--out', rel('keep.png')], () => {}, same);
    expect(same.media).toHaveLength(0);
    expect(safeExistsSync(path.join(workDir, 'keep.png'))).toBe(true);
    expect(safeExistsSync(path.join(workDir, 'keep.webp.png'))).toBe(false);

    const jpegIntoPng = createFakeDrawDeps({ bytes: JPEG_BYTES });
    await runDrawCommand(['x', '--out', rel('j.png')], () => {}, jpegIntoPng);
    expect(jpegIntoPng.media).toHaveLength(1);
    const landed = safeReadFile(path.join(workDir, 'j.png'), { encoding: null }) as Buffer;
    expect(landed.readUInt32BE(0)).toBe(0x89504e47);
  });

  it('keeps only the tail of a provider traceback', () => {
    const traceback = [
      '\u001b[36mDownloading\u001b[39m x',
      'Traceback:',
      '  File "a.py"',
      'GatedRepoError: 401',
      'Please log in.',
    ].join('\n');
    expect(summarizeProviderError(traceback)).toBe(
      '… File "a.py" | GatedRepoError: 401 | Please log in.'
    );
    expect(summarizeProviderError('boom')).toBe('boom');
  });

  it('validates arguments and prints usage', async () => {
    const deps = createFakeDrawDeps();
    await expect(runDrawCommand(['x'], () => {}, deps)).rejects.toThrow(
      /--out <image> is required/
    );
    await expect(runDrawCommand(['x', '--out', rel('a.gif')], () => {}, deps)).rejects.toThrow(
      /unsupported file type/
    );
    await expect(runDrawCommand(['x', '--out', '/tmp/a.png'], () => {}, deps)).rejects.toThrow(
      /must be inside the repository/
    );
    for (const aspect of ['wide', '0:0', '16:0']) {
      await expect(
        runDrawCommand(['x', '--out', rel('a.png'), '--aspect', aspect], () => {}, deps)
      ).rejects.toThrow(/--aspect must look like 16:9/);
    }
    const mislabeled = path.join(workDir, 'fake.jpg');
    safeWriteFile(mislabeled, pngBytes(4, 4));
    await expect(
      runDrawCommand(['x', '--out', rel('a.png'), '--ref', rel('fake.jpg')], () => {}, deps)
    ).rejects.toThrow(/contains png data but its extension says image\/jpeg/);
    await expect(
      runDrawCommand(['x', '--out', rel('a.png'), '--provider', 'dalle'], () => {}, deps)
    ).rejects.toThrow(/unknown provider "dalle"/);
    await expect(
      runDrawCommand(
        ['x', '--out', rel('a.png'), '--provider', 'codex_host_bridge'],
        () => {},
        deps
      )
    ).rejects.toThrow(/add --allow-handoff/);
    await expect(
      runDrawCommand(
        ['x', '--out', rel('a.png'), '--consent-provider', 'gemini_fast'],
        () => {},
        deps
      )
    ).rejects.toThrow(/must be given together/);
    await expect(runDrawCommand(['x', '--lang', 'ja'], () => {}, deps)).rejects.toThrow(
      /Unknown option: --lang/
    );
    await expect(runDrawCommand(['   ', '--out', rel('a.png')], () => {}, deps)).rejects.toThrow(
      /prompt is empty/
    );
    await expect(runDrawCommand([], () => {}, deps)).rejects.toThrow(/Usage: pnpm kyberion draw/);
    const output: string[] = [];
    await runDrawCommand(['--help'], (t) => output.push(t), deps);
    expect(output[0]).toBe(DRAW_USAGE);
    expect(deps.requests).toHaveLength(0);
  });
});
