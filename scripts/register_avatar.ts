import * as path from 'node:path';
import {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcAvatar = path.resolve(args['src-avatar'] || 'active/shared/tmp/avatar.png');
  const destAvatarDir = path.resolve(args['dest-avatar-dir'] || 'knowledge/personal');
  const destAvatar = path.resolve(args['dest-avatar'] || path.join(destAvatarDir, 'avatar.png'));
  const identityJsonPath = path.resolve(
    args['identity-path'] || path.join(destAvatarDir, 'my-identity.json')
  );
  const profileName = args['profile-name'] || 'user';
  const language = args.language || 'Japanese';
  const interactionStyle = args['interaction-style'] || 'Concierge';
  const avatarPath =
    args['avatar-path'] || path.relative(destAvatarDir, destAvatar) || 'avatar.png';

  if (!safeExistsSync(srcAvatar)) {
    console.error(`Source avatar not found at ${srcAvatar}`);
    process.exit(1);
  }

  console.log(`Copying avatar from ${srcAvatar} to ${destAvatar}...`);
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
    console.warn(`Identity file not found at ${identityJsonPath}. Creating a default one...`);
    const defaultIdentity = {
      ...identityBase,
      created_at: new Date().toISOString(),
      status: 'active',
      version: '1.0.0',
    };
    safeWriteFile(identityJsonPath, JSON.stringify(defaultIdentity, null, 2), { encoding: 'utf8' });
  } else {
    console.log(`Reading identity file from ${identityJsonPath}...`);
    const identityContent = safeReadFile(identityJsonPath, { encoding: 'utf8' }) as string;
    try {
      const identity = JSON.parse(identityContent);
      if (args['profile-name']) identity.name = profileName;
      if (args.language) identity.language = language;
      if (args['interaction-style']) identity.interaction_style = interactionStyle;
      identity.avatar_path = avatarPath;
      identity.updated_at = new Date().toISOString();

      console.log('Updating identity file to register avatar...');
      safeWriteFile(identityJsonPath, JSON.stringify(identity, null, 2), { encoding: 'utf8' });
    } catch (err: any) {
      console.error(`Failed to parse identity JSON: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('Successfully registered avatar in personal profile!');
}

main();
