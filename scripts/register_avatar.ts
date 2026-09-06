import * as path from 'node:path';
import { loadPersonalIdentityAtPath } from '@agent/core/personal-identity-reader';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { isRecord, nowIso } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

export function normalizeIdentityRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) continue;
    result[key] = next;
    index += 1;
  }
  return result;
}

export interface AvatarRegistrationPaths {
  srcAvatar: string;
  destAvatarDir: string;
  destAvatar: string;
  identityJsonPath: string;
}

export function resolveAvatarRegistrationPaths(
  args: Record<string, string>
): AvatarRegistrationPaths {
  const srcAvatar = assertSafeRepositoryPath(
    pathResolver.resolve(args['src-avatar'] || 'active/shared/tmp/avatar.png'),
    { allowMissingLeaf: true }
  );
  const destAvatarDir = assertSafeRepositoryPath(
    pathResolver.resolve(args['dest-avatar-dir'] || 'knowledge/personal'),
    { allowMissingLeaf: true }
  );
  const destAvatar = assertSafeRepositoryPath(
    pathResolver.resolve(args['dest-avatar'] || path.join(destAvatarDir, 'avatar.png')),
    { allowMissingLeaf: true }
  );
  const identityJsonPath = assertSafeRepositoryPath(
    pathResolver.resolve(args['identity-path'] || path.join(destAvatarDir, 'my-identity.json')),
    { allowMissingLeaf: true }
  );
  return { srcAvatar, destAvatarDir, destAvatar, identityJsonPath };
}

function main(argv: string[], print: Print = () => undefined) {
  const args = parseArgs(argv);
  const { srcAvatar, destAvatarDir, destAvatar, identityJsonPath } =
    resolveAvatarRegistrationPaths(args);
  const profileName = args['profile-name'] || 'user';
  const language = args.language || 'Japanese';
  const interactionStyle = args['interaction-style'] || 'Concierge';
  const avatarPath =
    args['avatar-path'] || path.relative(destAvatarDir, destAvatar) || 'avatar.png';

  if (!safeExistsSync(srcAvatar)) {
    throw new Error(`Source avatar not found at ${srcAvatar}`);
  }
  if (!safeLstat(srcAvatar).isFile()) {
    throw new Error(`Source avatar must be a regular file: ${srcAvatar}`);
  }

  print(`Copying avatar from ${srcAvatar} to ${destAvatar}...`);
  if (!safeExistsSync(destAvatarDir)) {
    safeMkdir(destAvatarDir, { recursive: true });
  }
  safeCopyFileSync(srcAvatar, destAvatar);

  const identityBase = {
    name: profileName,
    language,
    interaction_style: interactionStyle,
    avatar_path: avatarPath,
  };

  if (!safeExistsSync(identityJsonPath)) {
    print(`Identity file not found at ${identityJsonPath}. Creating a default one...`);
    const defaultIdentity = {
      ...identityBase,
      created_at: nowIso(),
      status: 'active',
      version: '1.0.0',
    };
    safeWriteFile(identityJsonPath, JSON.stringify(defaultIdentity, null, 2), { encoding: 'utf8' });
  } else {
    print(`Reading identity file from ${identityJsonPath}...`);
    if (!safeLstat(identityJsonPath).isFile()) {
      throw new Error(`Identity file must be a regular file: ${identityJsonPath}`);
    }
    try {
      const identity = loadPersonalIdentityAtPath(identityJsonPath);
      if (!identity) {
        throw new Error('identity JSON root must be an object');
      }
      if (args['profile-name']) identity.name = profileName;
      if (args.language) identity.language = language;
      if (args['interaction-style']) identity.interaction_style = interactionStyle;
      identity.avatar_path = avatarPath;
      identity.updated_at = nowIso();

      print('Updating identity file to register avatar...');
      safeWriteFile(identityJsonPath, JSON.stringify(identity, null, 2), { encoding: 'utf8' });
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse identity JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  print('Successfully registered avatar in personal profile!');
}

export const runRegisterAvatar = defineScript({
  name: 'avatar:register',
  flags: [],
  run(context) {
    return main(context.argv, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'register_avatar.ts') ||
  isDirectScript(import.meta.url, 'register_avatar.js')
)
  void runRegisterAvatar();
