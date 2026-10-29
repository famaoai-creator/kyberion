import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import {
  ObsVirtualCamera,
  validateObsSourceFilterRequest,
  type ObsSourceFilterRequest,
} from './obs-virtual-camera-output.js';

interface FakeObsOptions {
  requireAuth?: boolean;
  existingScenes?: string[];
  existingInputs?: string[];
  filters?: Array<{
    filterName: string;
    filterKind: string;
    filterEnabled: boolean;
    filterIndex: number;
    filterSettings: Record<string, unknown>;
  }>;
  rejectAuthentication?: boolean;
  omitIdentified?: boolean;
  responseOp?: number;
  staleReadback?: boolean;
  rejectDisable?: boolean;
}

function startFakeObsServer(options: FakeObsOptions = {}): Promise<{
  port: number;
  requests: Array<{ requestType: string; requestData?: unknown }>;
  identifications: unknown[];
  close: () => Promise<void>;
}> {
  const requests: Array<{ requestType: string; requestData?: unknown }> = [];
  const identifications: unknown[] = [];
  const filters = (options.filters ?? []).map((filter) => ({
    ...filter,
    filterSettings: { ...filter.filterSettings },
  }));
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        requests,
        identifications,
        close: () =>
          new Promise<void>((done) => {
            wss.close(() => done());
          }),
      });
    });
    wss.on('connection', (socket: any) => {
      socket.send(
        JSON.stringify({
          op: 0,
          d: options.requireAuth
            ? { rpcVersion: 1, authentication: { challenge: 'ch', salt: 'sa' } }
            : { rpcVersion: 1 },
        })
      );
      socket.on('message', (raw: any) => {
        let parsed: any;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (parsed.op === 1) {
          identifications.push(parsed.d);
          if (options.rejectAuthentication) socket.close(4009, 'Authentication failed');
          else if (!options.omitIdentified)
            socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          return;
        }
        if (parsed.op !== 6) return;
        const { requestType, requestId, requestData } = parsed.d;
        requests.push({ requestType, requestData });
        if (
          options.rejectDisable &&
          requestType === 'SetSourceFilterEnabled' &&
          requestData?.filterEnabled === false
        ) {
          socket.send(
            JSON.stringify({
              op: 7,
              d: {
                requestType,
                requestId,
                requestStatus: { result: false, code: 500, comment: 'fixture disable failed' },
              },
            })
          );
          return;
        }
        const data = respond(requestType, requestData);
        socket.send(
          JSON.stringify({
            op: options.responseOp ?? 7,
            d: { requestType, requestId, requestStatus: { result: true }, responseData: data },
          })
        );
      });
    });
    function respond(requestType: string, requestData: any): Record<string, unknown> {
      if (requestType === 'GetSceneList') {
        return { scenes: (options.existingScenes ?? []).map((sceneName) => ({ sceneName })) };
      }
      if (requestType === 'GetInputList') {
        return { inputs: (options.existingInputs ?? []).map((inputName) => ({ inputName })) };
      }
      if (requestType === 'GetSourceFilterList') return { filters };
      if (requestType === 'CreateSourceFilter')
        filters.push({
          filterName: requestData.filterName,
          filterKind: requestData.filterKind,
          filterEnabled: true,
          filterIndex: filters.length,
          filterSettings: requestData.filterSettings,
        });
      const filter = filters.find((item) => item.filterName === requestData?.filterName);
      if (filter && requestType === 'SetSourceFilterSettings')
        Object.assign(filter.filterSettings, requestData.filterSettings);
      if (filter && requestType === 'SetSourceFilterEnabled')
        filter.filterEnabled = requestData.filterEnabled;
      if (requestType === 'GetSourceFilter') return options.staleReadback ? {} : (filter ?? {});
      return {};
    }
  });
}

describe('ObsVirtualCamera', () => {
  it('accepts native unsigned ABGR colors and rejects values beyond uint32', () => {
    const request = {
      sourceName: 'Camera',
      filterName: 'Custom Key',
      kind: 'chroma_key_filter_v2' as const,
      settings: { key_color_type: 'custom' as const, key_color: 0xff563412 },
    };
    expect(validateObsSourceFilterRequest(request).settings).toMatchObject({
      key_color: 0xff563412,
    });
    expect(() =>
      validateObsSourceFilterRequest({ ...request, settings: { key_color: 0x100000000 } })
    ).toThrow('OBS_FILTER_INVALID');
  });
  it('applies a live source filter and verifies it without changing scenes or camera state', async () => {
    const server = await startFakeObsServer({ requireAuth: true });
    try {
      const camera = new ObsVirtualCamera({ port: server.port, password: 'fixture-password' });
      expect(
        await camera.applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Kyberion Color',
          kind: 'color_filter_v2',
          settings: { saturation: -1 },
        })
      ).toEqual({
        filterName: 'Kyberion Color',
        filterKind: 'color_filter_v2',
        filterEnabled: true,
        filterIndex: 0,
      });
      expect(server.requests.map((entry) => entry.requestType)).toEqual([
        'GetSourceFilterList',
        'CreateSourceFilter',
        'SetSourceFilterEnabled',
        'GetSourceFilter',
      ]);
      const sha = (value: string) => createHash('sha256').update(value).digest('base64');
      expect(server.identifications).toEqual([
        {
          rpcVersion: 1,
          eventSubscriptions: 0,
          authentication: sha(sha('fixture-passwordsa') + 'ch'),
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('updates an existing filter by overlay and returns metadata without arbitrary plugin settings', async () => {
    const server = await startFakeObsServer({
      filters: [
        {
          filterName: 'Key',
          filterKind: 'chroma_key_filter_v2',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: { private_token: 'never-return', similarity: 400 },
        },
      ],
    });
    try {
      const camera = new ObsVirtualCamera({ port: server.port });
      expect(await camera.listSourceFilters('Camera')).toEqual([
        {
          filterName: 'Key',
          filterKind: 'chroma_key_filter_v2',
          filterEnabled: true,
          filterIndex: 0,
        },
      ]);
      await camera.applySourceFilter({
        sourceName: 'Camera',
        filterName: 'Key',
        kind: 'chroma_key_filter_v2',
        settings: { similarity: 500, key_color_type: 'green' },
        enabled: false,
      });
      expect(
        server.requests.find((entry) => entry.requestType === 'SetSourceFilterSettings')
          ?.requestData
      ).toMatchObject({ overlay: true, filterSettings: { similarity: 500 } });
      expect(server.requests.some((entry) => entry.requestType === 'CreateSourceFilter')).toBe(
        false
      );
      expect(server.requests.map((entry) => entry.requestType)).toEqual([
        'GetSourceFilterList', // the explicit metadata inspection above
        'GetSourceFilterList',
        'SetSourceFilterEnabled',
        'SetSourceFilterSettings',
        'GetSourceFilter',
      ]);
    } finally {
      await server.close();
    }
  });

  it('does not mutate settings when disabling an existing live filter fails', async () => {
    const server = await startFakeObsServer({
      rejectDisable: true,
      filters: [
        {
          filterName: 'Color',
          filterKind: 'color_filter_v2',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: { saturation: 0 },
        },
      ],
    });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port }).applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Color',
          kind: 'color_filter_v2',
          settings: { saturation: -1 },
          enabled: false,
        })
      ).rejects.toThrow('fixture disable failed');
      expect(server.requests.map((entry) => entry.requestType)).toEqual([
        'GetSourceFilterList',
        'SetSourceFilterEnabled',
      ]);
    } finally {
      await server.close();
    }
  });

  it('refuses existing filter kind drift before mutation', async () => {
    const server = await startFakeObsServer({
      filters: [
        {
          filterName: 'Effect',
          filterKind: 'crop_filter',
          filterEnabled: true,
          filterIndex: 0,
          filterSettings: {},
        },
      ],
    });
    try {
      const camera = new ObsVirtualCamera({ port: server.port });
      await expect(
        camera.applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Effect',
          kind: 'color_filter_v2',
          settings: {},
        })
      ).rejects.toThrow('OBS_FILTER_KIND_DRIFT');
      expect(server.requests.map((entry) => entry.requestType)).toEqual(['GetSourceFilterList']);
    } finally {
      await server.close();
    }
  });

  it('refuses disabled creation instead of briefly enabling an unrequested effect', async () => {
    const server = await startFakeObsServer();
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port }).applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Crop',
          kind: 'crop_filter',
          settings: {},
          enabled: false,
        })
      ).rejects.toThrow('OBS_FILTER_DISABLED_CREATE');
      expect(server.requests.map((entry) => entry.requestType)).toEqual(['GetSourceFilterList']);
    } finally {
      await server.close();
    }
  });

  it.each([
    { kind: 'color_filter_v2', settings: { opacity: 100 } },
    { kind: 'chroma_key_filter_v2', settings: { similarity: 1.5 } },
    { kind: 'crop_filter', settings: { cx: Number.NaN } },
    { kind: 'crop_filter', settings: { shader_path: '/tmp/custom.effect' } },
    { kind: 'unknown', settings: {} },
    { kind: 'color_filter_v2', settings: { brightness: Infinity } },
  ])('rejects invalid filter settings without connecting: %j', async (invalid) => {
    let connected = false;
    const camera = new ObsVirtualCamera({
      connect: async () => {
        connected = true;
        throw new Error('must not connect');
      },
    });
    await expect(
      camera.applySourceFilter({
        sourceName: 'Camera',
        filterName: 'Effect',
        ...invalid,
      } as ObsSourceFilterRequest)
    ).rejects.toThrow('OBS_FILTER_INVALID');
    expect(connected).toBe(false);
  });

  it('snapshots a validated effect so caller mutation cannot change an admitted request', () => {
    const input: ObsSourceFilterRequest = {
      sourceName: 'Camera',
      filterName: 'Crop',
      kind: 'crop_filter',
      settings: { relative: true, left: 10 },
    };
    const snapshot = validateObsSourceFilterRequest(input);
    input.settings.left = 100;
    expect(snapshot.settings).toEqual({ relative: true, left: 10 });
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
  });

  it('fails closed if OBS accepts mutations but does not confirm the state', async () => {
    const server = await startFakeObsServer({ staleReadback: true });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port }).applySourceFilter({
          sourceName: 'Camera',
          filterName: 'Crop',
          kind: 'crop_filter',
          settings: { left: 10 },
        })
      ).rejects.toThrow('OBS_FILTER_UNVERIFIED');
    } finally {
      await server.close();
    }
  });

  it('does not send requests before Identified and promptly rejects authentication close', async () => {
    const server = await startFakeObsServer({ requireAuth: true, rejectAuthentication: true });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port, password: 'incorrect' }).listSourceFilters(
          'Camera'
        )
      ).rejects.toThrow('closed during identify');
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('times out identification without sending any request', async () => {
    const server = await startFakeObsServer({ omitIdentified: true });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port, timeoutMs: 1000 }).listSourceFilters('Camera')
      ).rejects.toThrow('identify timed out');
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('ignores a matching request id in an event instead of accepting it as a response', async () => {
    const server = await startFakeObsServer({ responseOp: 5 });
    try {
      await expect(
        new ObsVirtualCamera({ port: server.port, timeoutMs: 1000 }).listSourceFilters('Camera')
      ).rejects.toThrow('request: GetSourceFilterList timed out');
    } finally {
      await server.close();
    }
  });
  it('creates scene and looping source, then starts the virtual camera', async () => {
    const server = await startFakeObsServer();
    try {
      const camera = new ObsVirtualCamera({ port: server.port, timeoutMs: 5000 });
      const result = await camera.startAvatarOutput({ videoPath: '/tmp/avatar.mp4' });
      expect(result).toEqual({
        scene: 'Kyberion Avatar',
        source: 'Avatar Video',
        virtualCamStarted: true,
      });
      const types = server.requests.map((entry) => entry.requestType);
      expect(types).toEqual([
        'GetSceneList',
        'CreateScene',
        'SetCurrentProgramScene',
        'GetInputList',
        'CreateInput',
        'StartVirtualCam',
      ]);
      const create = server.requests.find((entry) => entry.requestType === 'CreateInput');
      expect(create?.requestData).toMatchObject({
        inputKind: 'ffmpeg_source',
        inputSettings: { local_file: '/tmp/avatar.mp4', loop: true },
      });
    } finally {
      await server.close();
    }
  });

  it('reuses an existing scene and source via settings update', async () => {
    const server = await startFakeObsServer({
      existingScenes: ['Kyberion Avatar'],
      existingInputs: ['Avatar Video'],
    });
    try {
      const camera = new ObsVirtualCamera({ port: server.port, timeoutMs: 5000 });
      await camera.startAvatarOutput({ videoPath: '/tmp/b.mp4' });
      const types = server.requests.map((entry) => entry.requestType);
      expect(types).not.toContain('CreateScene');
      expect(types).toContain('SetInputSettings');
      expect(types).not.toContain('CreateInput');
    } finally {
      await server.close();
    }
  });

  it('fails closed with setup guidance when OBS is unreachable', async () => {
    const camera = new ObsVirtualCamera({ port: 1, timeoutMs: 1000 });
    await expect(camera.startAvatarOutput({ videoPath: '/tmp/a.mp4' })).rejects.toThrow(
      /OBS is not reachable/
    );
  });

  it('demands the password when the server challenges', async () => {
    const server = await startFakeObsServer({ requireAuth: true });
    try {
      const camera = new ObsVirtualCamera({ port: server.port, timeoutMs: 5000 });
      await expect(camera.startAvatarOutput({ videoPath: '/tmp/a.mp4' })).rejects.toThrow(
        /KYBERION_OBS_WS_PASSWORD/
      );
    } finally {
      await server.close();
    }
  });
});
