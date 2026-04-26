import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core';
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

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

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

  it('accepts the canonical mobile app profile schema example', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/mobile-app-profile.schema.json');

    expect(validate(validProfile)).toBe(true);
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

  it('accepts the canonical mobile app profile index example', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/mobile-app-profile-index.schema.json');

    expect(validate(validIndex)).toBe(true);
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

  it('accepts the canonical web app profile schema example', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/web-app-profile.schema.json');

    const canonicalProfile = {
      app_id: 'example-web-login-guarded',
      title: 'Example Web Login + Guarded Routes',
      base_url: 'http://127.0.0.1:4173',
      execution_preset: 'standard-web-auth',
      login_route: '/login',
      logout_route: '/logout',
      guarded_routes: ['/app/home', '/app/settings'],
      selectors: {
        login: {
          email: "[data-testid='email']",
          password: "[data-testid='password']",
          submit: "[data-testid='sign-in']",
        },
        navigation: {
          home: "[data-testid='nav-home']",
          settings: "[data-testid='nav-settings']",
          logout: "[data-testid='nav-logout']",
        },
      },
      session_handoff: {
        kind: 'webview-session-handoff',
        target_url: 'http://127.0.0.1:4173/app/home',
        origin: 'http://127.0.0.1:4173',
        browser_session_id: 'example-web-login-guarded',
        prefer_persistent_context: true,
      },
      debug_routes: {
        session_export: '/__kyberion/session-export',
      },
    };

    expect(validate(canonicalProfile)).toBe(true);
  });

  it('accepts a valid webview session handoff contract', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/webview-session-handoff.schema.json');

    const handoff = {
      kind: 'webview-session-handoff',
      target_url: 'http://127.0.0.1:4173/app/home',
      origin: 'app://com.example.mobile',
      browser_session_id: 'session-1',
      prefer_persistent_context: true,
      source: {
        platform: 'android',
        app_id: 'example-mobile-login-passkey',
      },
    };

    expect(validate(handoff)).toBe(true);
  });

  it('rejects an invalid webview session handoff contract', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/webview-session-handoff.schema.json');

    const handoff = {
      kind: 'webview-session-handoff',
      target_url: '',
      source: {
        platform: 'desktop',
      },
    };

    expect(validate(handoff)).toBe(false);
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

  it('accepts the canonical web app profile index example', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, 'knowledge/public/schemas/web-app-profile-index.schema.json');

    expect(validate({
      profiles: [
        {
          id: 'example-web-login-guarded',
          platform: 'browser',
          title: 'Example Web Login + Guarded Routes',
          path: 'knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json',
          description: 'Shared profile for a Web app with login, guarded routes, and a debug-only session export route.',
          tags: ['browser', 'session-handoff', 'login', 'guarded-routes', 'example'],
        },
      ],
    })).toBe(true);
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
