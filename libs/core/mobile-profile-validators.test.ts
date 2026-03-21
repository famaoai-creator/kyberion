import { describe, expect, it } from 'vitest';
import {
  assertValidMobileAppProfile,
  assertValidMobileAppProfileIndex,
  assertValidWebAppProfile,
  assertValidWebAppProfileIndex,
  validateMobileAppProfile,
  validateMobileAppProfileIndex,
  validateWebAppProfile,
  validateWebAppProfileIndex,
} from './mobile-profile-validators.js';

describe('mobile-profile-validators', () => {
  const validProfile = {
    app_id: 'example-mobile-login-passkey',
    platform: 'android',
    title: 'Example Mobile Login + Passkey',
    package_name: 'com.example.mobile',
    launch: {
      component: 'com.example.mobile/.MainActivity',
    },
    selectors: {
      login: {
        email: {
          resource_id: 'email',
          class_name: 'EditText',
        },
        password: {
          resource_id: 'password',
          class_name: 'EditText',
        },
        submit: {
          text: 'sign in',
          resource_id: 'sign_in',
          class_name: 'Button',
        },
      },
      passkey: {
        trigger: {
          text: 'passkey',
          resource_id: 'passkey',
          class_name: 'Button',
        },
      },
    },
  };

  const validIndex = {
    version: '1.0.0',
    profiles: [
      {
        id: 'example-mobile-login-passkey',
        platform: 'android',
        title: 'Example Mobile Login + Passkey',
        path: 'knowledge/public/orchestration/mobile-app-profiles/example-mobile-login-passkey.json',
        description: 'Example Android app profile covering launch, login form selectors, and passkey trigger selectors.',
        tags: ['android', 'login', 'passkey', 'example'],
      },
    ],
  };

  it('accepts a valid mobile app profile', () => {
    expect(validateMobileAppProfile(validProfile)).toEqual([]);
    expect(() => assertValidMobileAppProfile(validProfile, 'test.profile')).not.toThrow();
  });

  it('rejects an invalid mobile app profile', () => {
    const invalidProfile = {
      app_id: '',
      platform: 'android',
      package_name: '',
      selectors: {
        login: {
          email: {},
        },
      },
    };

    const errors = validateMobileAppProfile(invalidProfile);
    expect(errors).toContain('app_id is required');
    expect(errors).toContain('package_name is required');
    expect(errors).toContain('selectors.login.email must include at least one selector field');
    expect(() => assertValidMobileAppProfile(invalidProfile, 'test.profile')).toThrow('Invalid mobile app profile');
  });

  it('accepts a valid mobile app profile index when paths exist', () => {
    expect(validateMobileAppProfileIndex(validIndex, () => true)).toEqual([]);
    expect(() => assertValidMobileAppProfileIndex(validIndex, 'test.index', () => true)).not.toThrow();
  });

  it('rejects an invalid mobile app profile index', () => {
    const invalidIndex = {
      profiles: [
        {
          id: '',
          platform: 'desktop',
          title: '',
          path: 'missing.json',
          description: '',
          tags: ['ok', 1],
        },
      ],
    };

    const errors = validateMobileAppProfileIndex(invalidIndex, () => false);
    expect(errors).toContain('profiles[0].id is required');
    expect(errors).toContain('profiles[0].platform must be android or ios');
    expect(errors).toContain('profiles[0].title is required');
    expect(errors).toContain('profiles[0].description is required');
    expect(errors).toContain('profiles[0].tags must be an array of strings');
    expect(errors).toContain('profiles[0].path does not exist: missing.json');
    expect(() => assertValidMobileAppProfileIndex(invalidIndex, 'test.index', () => false)).toThrow(
      'Invalid mobile app profile index',
    );
  });

  it('accepts a valid web app profile', () => {
    const validProfile = {
      app_id: 'example-web-login-guarded',
      title: 'Example Web Login + Guarded Routes',
      base_url: 'http://127.0.0.1:4173',
      guarded_routes: ['/app/home'],
      session_handoff: {
        kind: 'webview-session-handoff',
        target_url: 'http://127.0.0.1:4173/app/home',
      },
      debug_routes: {
        session_export: '/__kyberion/session-export',
      },
    };

    expect(validateWebAppProfile(validProfile)).toEqual([]);
    expect(() => assertValidWebAppProfile(validProfile, 'test.web.profile')).not.toThrow();
  });

  it('rejects an invalid web app profile', () => {
    const invalidProfile = {
      app_id: '',
      title: '',
      base_url: '',
      guarded_routes: ['/app/home', 1],
      debug_routes: {
        session_export: '',
      },
    };

    const errors = validateWebAppProfile(invalidProfile);
    expect(errors).toContain('app_id is required');
    expect(errors).toContain('title is required');
    expect(errors).toContain('base_url is required');
    expect(errors).toContain('guarded_routes must be an array of strings');
    expect(errors).toContain('debug_routes.session_export must be a non-empty string when provided');
    expect(() => assertValidWebAppProfile(invalidProfile, 'test.web.profile')).toThrow('Invalid web app profile');
  });

  it('accepts a valid web app profile index', () => {
    const validIndex = {
      profiles: [
        {
          id: 'example-web-login-guarded',
          platform: 'browser',
          title: 'Example Web Login + Guarded Routes',
          path: 'knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json',
          description: 'Example Web app profile covering login, guarded routes, and debug session export.',
          tags: ['browser', 'session-handoff'],
        },
      ],
    };

    expect(validateWebAppProfileIndex(validIndex, () => true)).toEqual([]);
    expect(() => assertValidWebAppProfileIndex(validIndex, 'test.web.index', () => true)).not.toThrow();
  });

  it('rejects an invalid web app profile index', () => {
    const invalidIndex = {
      profiles: [
        {
          id: '',
          platform: 'desktop',
          title: '',
          path: 'missing-web.json',
          description: '',
          tags: ['ok', 1],
        },
      ],
    };

    const errors = validateWebAppProfileIndex(invalidIndex, () => false);
    expect(errors).toContain('profiles[0].id is required');
    expect(errors).toContain('profiles[0].platform must be browser');
    expect(errors).toContain('profiles[0].title is required');
    expect(errors).toContain('profiles[0].description is required');
    expect(errors).toContain('profiles[0].tags must be an array of strings');
    expect(errors).toContain('profiles[0].path does not exist: missing-web.json');
    expect(() => assertValidWebAppProfileIndex(invalidIndex, 'test.web.index', () => false)).toThrow(
      'Invalid web app profile index',
    );
  });
});
