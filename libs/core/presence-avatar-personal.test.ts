import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  AVATAR_PROFILE_POINTER,
  describePersonalAvatar,
  getUserPresenceAvatarProfile,
  loadPersonalAvatarSet,
  parsePersonalAvatarProfile,
  promotePersonalAvatarDraft,
  readPersonalAvatarAsset,
} from './presence-avatar.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

describe('personal avatar overlay', () => {
  const root = pathResolver.sharedTmp(`presence-avatar-personal-${process.pid}`);
  const dir = path.join(root, 'avatar');

  function writeProfile(profile: unknown) {
    safeWriteFile(path.join(dir, 'avatar-profile.json'), JSON.stringify(profile));
  }

  beforeEach(() => {
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'neutral.png'), PNG);
    safeWriteFile(path.join(dir, 'joy.png'), PNG);
    safeWriteFile(path.join(dir, 'notes.txt'), 'not an image');
    safeWriteFile(path.join(root, 'secret.png'), PNG);
    writeProfile({
      version: 1,
      images: { neutral: 'neutral.png', joy: 'joy.png', thinking: 'missing.png' },
      mouth: { x: 0.4, y: 0.7, width: 0.2 },
      generated_at: '2026-09-24T00:00:00Z',
      provider_id: 'gemini_image',
      style: 'friendly',
    });
  });

  afterEach(() => safeRmSync(root, { recursive: true, force: true }));

  it('loads only frames that exist inside the avatar directory', () => {
    const set = loadPersonalAvatarSet(root);
    expect(Object.keys(set!.files).sort()).toEqual(['joy', 'neutral']);
    expect(set!.profile.mouth).toEqual({ x: 0.4, y: 0.7, width: 0.2 });
  });

  it('drops traversal and non-image file names from the profile', () => {
    const parsed = parsePersonalAvatarProfile({
      images: {
        neutral: 'neutral.png',
        joy: '../secret.png',
        thinking: 'a/b.png',
        speaking: 'x.svg',
      },
    });
    expect(parsed!.images).toEqual({ neutral: 'neutral.png' });
    expect(parsed!.mouth).toEqual({ x: 0.5, y: 0.68, width: 0.22 });
    expect(parsePersonalAvatarProfile({ images: { joy: 'joy.png' } })).toBeNull();
  });

  it('serves bytes only for allow-listed expressions with a sniffed content type', () => {
    expect(readPersonalAvatarAsset('neutral', root)).toEqual({
      bytes: PNG,
      contentType: 'image/png',
    });
    expect(readPersonalAvatarAsset('../secret', root)).toBeNull();
    expect(readPersonalAvatarAsset('thinking', root)).toBeNull();
    expect(readPersonalAvatarAsset('avatar-profile', root)).toBeNull();
  });

  it('refuses a frame whose bytes are not an image', () => {
    writeProfile({ images: { neutral: 'neutral.png', joy: 'notes.txt' } });
    expect(readPersonalAvatarAsset('joy', root)).toBeNull();
  });

  it('describes the set as ui:talking-avatar images + mouth, adopted only via the identity pointer', () => {
    const wire = describePersonalAvatar('/api/me/avatar/', root);
    expect(wire).toMatchObject({
      images: { neutral: '/api/me/avatar/neutral', joy: '/api/me/avatar/joy' },
      adopted: false,
    });
    expect(getUserPresenceAvatarProfile('/api/me/avatar', root)).toBeNull();

    safeWriteFile(
      path.join(root, 'my-identity.json'),
      JSON.stringify({ name: 'me', avatar_profile: AVATAR_PROFILE_POINTER })
    );
    const profile = getUserPresenceAvatarProfile('/api/me/avatar', root);
    expect(profile).toMatchObject({
      agentId: 'user',
      defaultAvatarAssetPath: '/api/me/avatar/neutral',
      expressionAvatarMap: { neutral: '/api/me/avatar/neutral', joy: '/api/me/avatar/joy' },
    });
  });

  describe('draft set', () => {
    const draftDir = path.join(dir, 'draft');
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);

    function writeDraft() {
      safeMkdir(draftDir, { recursive: true });
      safeWriteFile(path.join(draftDir, 'neutral.png'), JPEG);
      safeWriteFile(path.join(draftDir, 'speaking.png'), JPEG);
      safeWriteFile(
        path.join(draftDir, 'avatar-profile.json'),
        JSON.stringify({
          version: 1,
          images: { neutral: 'neutral.png', speaking: 'speaking.png' },
          mouth: { x: 0.5, y: 0.6, width: 0.3 },
          generated_at: '2026-09-25T00:00:00Z',
          provider_id: 'mflux',
          style: 'new',
        })
      );
    }

    it('keeps the draft apart from the current set and serves it only when asked', () => {
      writeDraft();
      expect(loadPersonalAvatarSet(root)!.profile.provider_id).toBe('gemini_image');
      expect(loadPersonalAvatarSet(root, 'draft')!.profile.provider_id).toBe('mflux');
      expect(readPersonalAvatarAsset('neutral', root)!.contentType).toBe('image/png');
      expect(readPersonalAvatarAsset('neutral', root, 'draft')!.contentType).toBe('image/jpeg');
      expect(readPersonalAvatarAsset('speaking', root)).toBeNull();

      safeWriteFile(
        path.join(root, 'my-identity.json'),
        JSON.stringify({ name: 'me', avatar_profile: AVATAR_PROFILE_POINTER })
      );
      expect(describePersonalAvatar('/api/me/avatar', root, 'draft')).toMatchObject({
        images: {
          neutral: '/api/me/avatar/neutral?set=draft',
          speaking: '/api/me/avatar/speaking?set=draft',
        },
        adopted: false,
        set: 'draft',
      });
      expect(describePersonalAvatar('/api/me/avatar', root)).toMatchObject({
        adopted: true,
        set: 'current',
      });
    });

    it('promotes the draft over the current set and removes the draft', () => {
      writeDraft();
      const promoted = promotePersonalAvatarDraft(root);
      expect(promoted!.profile).toMatchObject({ provider_id: 'mflux', style: 'new' });
      expect(Object.keys(promoted!.files).sort()).toEqual(['neutral', 'speaking']);
      expect(readPersonalAvatarAsset('neutral', root)!.contentType).toBe('image/jpeg');
      // joy belonged only to the previous set.
      expect(readPersonalAvatarAsset('joy', root)).toBeNull();
      expect(loadPersonalAvatarSet(root, 'draft')).toBeNull();
    });

    it('leaves the current set alone when there is no draft', () => {
      expect(promotePersonalAvatarDraft(root)).toBeNull();
      expect(Object.keys(loadPersonalAvatarSet(root)!.files).sort()).toEqual(['joy', 'neutral']);
    });
  });

  it('returns null without a profile file', () => {
    expect(loadPersonalAvatarSet(path.join(root, 'nowhere'))).toBeNull();
  });
});
