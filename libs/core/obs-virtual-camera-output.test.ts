import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ObsVirtualCamera } from './obs-virtual-camera-output.js';

interface FakeObsOptions {
  requireAuth?: boolean;
  existingScenes?: string[];
  existingInputs?: string[];
}

function startFakeObsServer(options: FakeObsOptions = {}): Promise<{
  port: number;
  requests: Array<{ requestType: string; requestData?: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ requestType: string; requestData?: unknown }> = [];
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        requests,
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
        if (parsed.op === 1) return; // Identify — accepted silently
        if (parsed.op !== 6) return;
        const { requestType, requestId, requestData } = parsed.d;
        requests.push({ requestType, requestData });
        const data = respond(requestType);
        socket.send(
          JSON.stringify({
            op: 7,
            d: { requestType, requestId, requestStatus: { result: true }, responseData: data },
          })
        );
      });
    });
    function respond(requestType: string): Record<string, unknown> {
      if (requestType === 'GetSceneList') {
        return { scenes: (options.existingScenes ?? []).map((sceneName) => ({ sceneName })) };
      }
      if (requestType === 'GetInputList') {
        return { inputs: (options.existingInputs ?? []).map((inputName) => ({ inputName })) };
      }
      return {};
    }
  });
}

describe('ObsVirtualCamera', () => {
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
