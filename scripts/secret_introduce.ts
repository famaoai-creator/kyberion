#!/usr/bin/env node
/**
 * kyberion secret introduce | status | apply
 *
 * Safe secret introduction CLI — never accepts the secret value on argv.
 * Values come from a TTY hidden prompt or --from-file under active/shared/tmp/.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  applySecretIntroduction,
  describeIntroductionReadiness,
  proposeSecretIntroduction,
} from '@agent/core/secret-introduction';
import { resolveSecretIdentity } from '@agent/core/secret-identity';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeReadFile } from '@agent/core/secure-io';
import { defineScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

function parseArgs(argv: string[]): {
  verb: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(token);
  }
  const verb = positional[0] || '';
  return { verb, positional: positional.slice(1), flags };
}

function assertNoValueOnArgv(argv: string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--value' || token === '--secret' || token === '-v') {
      throw new ScriptExitError(
        1,
        '[SECRET_CLI] Refusing --value/--secret on argv. Use a hidden prompt or --from-file.'
      );
    }
  }
}

async function readSecretFromFile(filePath: string): Promise<string> {
  const tmpRoot = pathResolver.sharedTmp();
  const resolved = assertSafeRepositoryPath(
    path.isAbsolute(filePath) ? filePath : path.join(tmpRoot, filePath),
    { allowMissingLeaf: false }
  );
  const relativeToTmp = path.relative(tmpRoot, resolved);
  if (relativeToTmp.startsWith('..') || path.isAbsolute(relativeToTmp)) {
    throw new ScriptExitError(
      1,
      `[SECRET_CLI] --from-file must be under active/shared/tmp/ (got ${filePath})`
    );
  }
  const raw = String(safeReadFile(resolved, { encoding: 'utf8' }));
  const value = raw.replace(/\r?\n$/, '');
  if (!value) {
    throw new ScriptExitError(1, `[SECRET_CLI] --from-file is empty: ${resolved}`);
  }
  return value;
}

async function readSecretHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new ScriptExitError(
      1,
      '[SECRET_CLI] No TTY for hidden prompt. Re-run with --from-file <path>.'
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const wasRaw = stdin.isRaw;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    process.stdout.write(prompt);
    let value = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new ScriptExitError(1, '[SECRET_CLI] Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(Boolean(wasRaw));
      rl.close();
    };
    stdin.on('data', onData);
  });
}

async function collectSecret(flags: Record<string, string | boolean>): Promise<string> {
  const fromFile = flags['from-file'];
  if (typeof fromFile === 'string' && fromFile.trim()) {
    return readSecretFromFile(fromFile.trim());
  }
  return readSecretHidden('Secret value (hidden): ');
}

export async function runSecretCli(
  argv: string[],
  options: { print?: Print } = {}
): Promise<Record<string, unknown>> {
  assertNoValueOnArgv(argv);
  const print = options.print ?? ((value) => process.stdout.write(`${String(value)}\n`));
  const { verb, positional, flags } = parseArgs(argv);
  const json = flags.json === true;

  if (verb === 'introduce') {
    const serviceId = positional[0];
    const secretKey = positional[1];
    if (!serviceId || !secretKey) {
      throw new ScriptExitError(
        1,
        'Usage: kyberion secret introduce <serviceId> <secretKey> [--from-file PATH] [--reason TEXT] [--no-auto-approve]'
      );
    }
    const identity = resolveSecretIdentity(serviceId, secretKey);
    const reason =
      typeof flags.reason === 'string' && flags.reason.trim()
        ? flags.reason.trim()
        : `Introduce ${identity.envName}`;
    const proposed = proposeSecretIntroduction({
      serviceId,
      secretKey,
      reason,
      autoApproveLocal: flags['no-auto-approve'] !== true,
      channel: 'terminal',
      requestedBy: 'operator',
      requestedByContext: {
        surface: 'terminal',
        actorId: 'operator',
        actorRole: 'sovereign',
      },
    });

    const result: Record<string, unknown> = {
      phase: 'propose',
      approval_id: proposed.approvalId,
      status: proposed.status,
      auto_approved: proposed.autoApproved,
      env_name: proposed.identity.envName,
      storage_channel: proposed.storageChannel,
    };

    if (proposed.status === 'approved') {
      const value = await collectSecret(flags);
      const applied = await applySecretIntroduction({
        approvalId: proposed.approvalId,
        value,
        storageChannel: proposed.storageChannel,
        channel: proposed.channel,
        appliedBy: 'operator',
      });
      result.phase = 'applied';
      result.status = applied.status;
      result.changed_keys = applied.changedKeys;
      result.connection_path = applied.connectionPath;
    } else {
      result.next =
        `Approve with: pnpm kyberion approve ${proposed.approvalId} then ` +
        `pnpm kyberion secret apply ${proposed.approvalId} --from-file <path>`;
    }

    if (json) print(JSON.stringify(result));
    else {
      print(`approval_id=${result.approval_id}`);
      print(`status=${result.status}`);
      print(`env_name=${result.env_name}`);
      if (result.next) print(String(result.next));
      if (result.phase === 'applied') print('applied=true (value not printed)');
    }
    return result;
  }

  if (verb === 'apply') {
    const approvalId = positional[0];
    if (!approvalId) {
      throw new ScriptExitError(1, 'Usage: kyberion secret apply <approvalId> [--from-file PATH]');
    }
    const value = await collectSecret(flags);
    const applied = await applySecretIntroduction({
      approvalId,
      value,
      storageChannel: typeof flags.channel === 'string' ? flags.channel : 'terminal',
      channel: typeof flags.channel === 'string' ? flags.channel : 'terminal',
      appliedBy: 'operator',
    });
    const result = {
      phase: 'applied',
      approval_id: applied.approvalId,
      status: applied.status,
      env_name: applied.identity.envName,
      changed_keys: applied.changedKeys,
    };
    if (json) print(JSON.stringify(result));
    else {
      print(`approval_id=${result.approval_id}`);
      print(`status=${result.status}`);
      print(`env_name=${result.env_name}`);
      print('applied=true (value not printed)');
    }
    return result;
  }

  if (verb === 'status') {
    const serviceId = positional[0];
    if (!serviceId) {
      throw new ScriptExitError(1, 'Usage: kyberion secret status <serviceId>');
    }
    const readiness = describeIntroductionReadiness(serviceId);
    if (json) print(JSON.stringify(readiness));
    else {
      print(`service=${readiness.serviceId}`);
      print(`missing=${readiness.missing.join(',') || '(none)'}`);
      for (const row of readiness.identities) {
        print(`${row.identity.envName}=${row.present ? 'present' : 'missing'}`);
      }
    }
    return readiness as unknown as Record<string, unknown>;
  }

  throw new ScriptExitError(
    1,
    'Usage: kyberion secret <introduce|status|apply> ...\n' +
      '  introduce <serviceId> <secretKey> [--from-file PATH] [--reason TEXT] [--no-auto-approve]\n' +
      '  status <serviceId>\n' +
      '  apply <approvalId> [--from-file PATH]'
  );
}

export async function main(argv: string[]): Promise<void> {
  await runSecretCli(argv);
}

defineScript(import.meta.url, async (args) => {
  try {
    await main(args);
  } catch (error) {
    if (error instanceof ScriptExitError) throw error;
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
});
