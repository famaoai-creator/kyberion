import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import {
  BROWSER_BRIDGE_MAILBOX_ROOT,
  awaitBrowserBridgeResponse,
  enqueueBrowserBridgeRequest,
  loadBrowserBridgeRequest,
  respondBrowserBridgeRequest,
  type BrowserBridgeRequest,
} from '@agent/core/browser/browser-bridge-mailbox';
import { runBrowserBridgeCommand, type BrowserBridgeCliDeps } from './cli-browser-bridge.js';

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(BROWSER_BRIDGE_MAILBOX_ROOT), {
    recursive: true,
    force: true,
  });
});

function deps(overrides: Partial<BrowserBridgeCliDeps> = {}): BrowserBridgeCliDeps {
  return {
    enqueue: enqueueBrowserBridgeRequest,
    load: loadBrowserBridgeRequest,
    await: awaitBrowserBridgeResponse,
    actor: () => 'agent:cli-test',
    readFile: () => 'file input',
    ...overrides,
  };
}

async function run(argv: string[], d = deps()): Promise<string> {
  const out: string[] = [];
  await runBrowserBridgeCommand(argv, (text) => out.push(text), d);
  return out.join('\n');
}

describe('pnpm kyberion browser-bridge', () => {
  it('queues an observe request and reports its status as JSON', async () => {
    const queued = JSON.parse(
      await run([
        'request',
        'observe',
        '--purpose',
        'Read the invoice table',
        '--origins',
        'https://example.com,https://app.example.com',
        '--mission',
        'MSN-CLI-1',
        '--json',
      ])
    ) as BrowserBridgeRequest;
    expect(queued).toMatchObject({
      request_kind: 'observe_tab',
      status: 'pending',
      scope: { tier: 'personal' },
      requested_by: { actor_id: 'agent:cli-test', mission_id: 'MSN-CLI-1' },
      payload: {
        purpose: 'Read the invoice table',
        mode: 'text',
        allowed_origins: ['https://example.com', 'https://app.example.com'],
      },
    });
    const status = await run(['status', queued.request_id]);
    expect(status).toContain(`## Browser bridge request ${queued.request_id}`);
    expect(status).toContain('- status: pending');
  });

  it('builds infer and notify payloads and refuses invalid flags', async () => {
    const enqueue = vi.fn(enqueueBrowserBridgeRequest);
    await run(
      ['request', 'infer', '--task', 'summarize', '--input-file', 'x.txt'],
      deps({ enqueue })
    );
    expect(enqueue.mock.calls[0][0].payload).toEqual({ task: 'summarize', input: 'file input' });
    await run(
      [
        'request',
        'notify',
        '--title',
        'Approval needed',
        '--body',
        'Deploy waits for you',
        '--level',
        'approval_pending',
        '--approval',
        'a1b2',
        '--progress',
        '2/5',
      ],
      deps({ enqueue })
    );
    expect(enqueue.mock.calls[1][0].payload).toEqual({
      level: 'approval_pending',
      title: 'Approval needed',
      body: 'Deploy waits for you',
      approval_request_id: 'a1b2',
      progress: { done: 2, total: 5 },
    });
    await expect(run(['request', 'infer', '--task', 'execute', '--input', 'x'])).rejects.toThrow(
      /--task must be one of/
    );
    await expect(run(['request', 'observe', '--purpose', 'p', '--tier', 'secret'])).rejects.toThrow(
      /--tier must be/
    );
    await expect(
      run(['request', 'observe', '--purpose', 'p', '--tier', 'confidential'])
    ).rejects.toThrow(/confidential scope requires tenant_slug/);
    await expect(run(['request', 'click'])).rejects.toThrow(/Unknown request kind/);
  });

  it('rejects an --input-file from a higher tier or another tenant than the requested scope', async () => {
    const readFile = vi.fn(() => 'file input');
    const enqueue = vi.fn(((input) => ({
      request_id: 'BBR-x',
      ...input,
    })) as typeof enqueueBrowserBridgeRequest);
    const infer = (file: string, ...scope: string[]) =>
      run(
        ['request', 'infer', '--task', 'summarize', '--input-file', file, ...scope],
        deps({ readFile, enqueue })
      );
    await expect(infer('knowledge/personal/notes.md')).resolves.toBeDefined();
    await expect(infer('knowledge/personal/notes.md', '--tier', 'public')).rejects.toThrow(
      /holds personal data .* cannot be sent in the lower public scope/
    );
    await expect(
      infer('knowledge/confidential/acme/plan.md', '--tier', 'confidential', '--tenant', 'other')
    ).rejects.toThrow(/belongs to tenant 'acme'/);
    await expect(infer('knowledge/confidential/acme/plan.md', '--tier', 'public')).rejects.toThrow(
      /holds confidential\/acme data/
    );
    await expect(
      infer('active/shared/staging/confidential/acme/in.txt', '--tier', 'public')
    ).rejects.toThrow(/cannot be sent in the lower public scope/);
    await expect(
      infer(
        'active/shared/runtime/browser-bridge-mailbox/personal/shared/x.json',
        '--tier',
        'public'
      )
    ).rejects.toThrow(/holds personal data/);
    await expect(
      infer(pathResolver.rootResolve('knowledge/personal/notes.md'), '--tier', 'public')
    ).rejects.toThrow(/holds personal data/);
    await expect(infer('active/shared/tmp/job/in.txt', '--tier', 'public')).rejects.toThrow(
      /unpartitioned storage location/
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    // Matching scopes and paths outside knowledge/ and the floors keep the requested scope.
    await infer(
      'knowledge/confidential/acme/plan.md',
      '--tier',
      'confidential',
      '--tenant',
      'acme'
    );
    await infer('active/shared/tmp/job/in.txt');
    await infer('knowledge/public/guide.md', '--tier', 'public');
    await infer('docs/README.md', '--tier', 'public');
    expect(readFile).toHaveBeenCalledTimes(5);
  });

  it('classifies the symlink target of an --input-file, not just the written path', async () => {
    const job = `bb-cli-symlink-${process.pid}-${Date.now()}`;
    const tmpDir = `active/shared/tmp/${job}`;
    const targetDir = `active/shared/staging/confidential/acme/${job}`;
    const sovereign = (fn: () => void) =>
      withExecutionContext('sovereign_concierge', fn, 'sovereign');
    try {
      sovereign(() => {
        safeMkdir(pathResolver.rootResolve(targetDir), { recursive: true });
        safeWriteFile(pathResolver.rootResolve(`${targetDir}/secret.txt`), 'acme secret');
        safeMkdir(pathResolver.rootResolve(tmpDir), { recursive: true });
        safeSymlinkSync(
          pathResolver.rootResolve(`${targetDir}/secret.txt`),
          pathResolver.rootResolve(`${tmpDir}/leaf.txt`),
          'file'
        );
        safeSymlinkSync(
          pathResolver.rootResolve(targetDir),
          pathResolver.rootResolve(`${tmpDir}/dir`),
          'dir'
        );
      });
      const readFile = vi.fn((filePath: string) => `read:${filePath}`);
      const enqueue = vi.fn(((input) => ({
        request_id: 'BBR-x',
        ...input,
      })) as typeof enqueueBrowserBridgeRequest);
      const infer = (file: string, ...scope: string[]) =>
        run(
          ['request', 'infer', '--task', 'summarize', '--input-file', file, ...scope],
          deps({ readFile, enqueue })
        );
      // The written path is plain legacy scratch; the target is acme's confidential staging.
      await expect(infer(`${tmpDir}/leaf.txt`)).rejects.toThrow(/belongs to tenant 'acme'/);
      await expect(infer(`${tmpDir}/dir/secret.txt`)).rejects.toThrow(/belongs to tenant 'acme'/);
      await expect(
        infer(`${tmpDir}/leaf.txt`, '--tier', 'confidential', '--tenant', 'other')
      ).rejects.toThrow(/belongs to tenant 'acme'/);
      // Outside the repository is refused outright.
      await expect(infer('/etc/hosts')).rejects.toThrow(/inside the repository/);
      expect(readFile).not.toHaveBeenCalled();
      // The owning scope is accepted, and the canonical (checked) path is what gets read.
      await infer(`${tmpDir}/leaf.txt`, '--tier', 'confidential', '--tenant', 'acme');
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(readFile.mock.calls[0][0]).toMatch(
        new RegExp(`active/shared/staging/confidential/acme/${job}/secret\\.txt$`)
      );

      // A link re-pointed into acme's tree while it is being read is rejected.
      sovereign(() => {
        safeWriteFile(pathResolver.rootResolve(`${tmpDir}/plain.txt`), 'plain');
        safeSymlinkSync(
          pathResolver.rootResolve(`${tmpDir}/plain.txt`),
          pathResolver.rootResolve(`${tmpDir}/swap.txt`),
          'file'
        );
      });
      enqueue.mockClear();
      const swappingRead = vi.fn((filePath: string) => {
        sovereign(() => {
          safeRmSync(pathResolver.rootResolve(`${tmpDir}/swap.txt`), { force: true });
          safeSymlinkSync(
            pathResolver.rootResolve(`${targetDir}/secret.txt`),
            pathResolver.rootResolve(`${tmpDir}/swap.txt`),
            'file'
          );
        });
        return `read:${filePath}`;
      });
      await expect(
        run(
          ['request', 'infer', '--task', 'summarize', '--input-file', `${tmpDir}/swap.txt`],
          deps({ readFile: swappingRead, enqueue })
        )
      ).rejects.toThrow(/belongs to tenant 'acme'|changed while it was being read/);
      expect(swappingRead).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      sovereign(() => {
        safeRmSync(pathResolver.rootResolve(tmpDir), { recursive: true, force: true });
        safeRmSync(pathResolver.rootResolve(targetDir), { recursive: true, force: true });
      });
    }
  });

  it('waits for the extension answer', async () => {
    const queued = enqueueBrowserBridgeRequest({
      request_kind: 'notify',
      payload: { level: 'info', title: 'Hello', body: 'World' },
      requested_by: { actor_id: 'agent:cli-test' },
      scope: { tier: 'personal' },
    });
    respondBrowserBridgeRequest(queued.request_id, { status: 'completed' });
    const out = await run(['wait', queued.request_id, '--timeout-sec', '1']);
    expect(out).toContain('- status: completed');
    await expect(run(['status', 'BBR-00000000-0000-4000-8000-000000000000'])).rejects.toThrow(
      /No browser bridge request/
    );
  });
});
