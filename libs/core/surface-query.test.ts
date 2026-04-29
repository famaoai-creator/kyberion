import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifySurfaceQueryIntent,
  extractSurfaceKnowledgeQuery,
  extractSurfaceWebSearchQuery,
  getSurfaceQueryProviderConfig,
  isSurfaceLocationQuery,
  isSurfaceWeatherQuery,
  resetSurfaceQueryProviderConfigCache,
} from './surface-query.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';

describe('surface-query', () => {
  const tmpDir = pathResolver.sharedTmp('surface-query-tests');
  const overridePath = path.join(tmpDir, 'surface-query-providers.json');
  const overlayPath = path.join(tmpDir, 'surface-query-providers.personal.json');

  afterEach(() => {
    delete process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH;
    delete process.env.KYBERION_PERSONAL_SURFACE_QUERY_CONFIG_PATH;
    delete process.env.KYBERION_SURFACE_QUERY_ROLE;
    delete process.env.KYBERION_SURFACE_QUERY_PHASE;
    resetSurfaceQueryProviderConfigCache();
  });

  it('classifies location and weather queries', () => {
    expect(isSurfaceLocationQuery('今の場所を教えて')).toBe(true);
    expect(isSurfaceWeatherQuery('今日の天気を教えて')).toBe(true);
    expect(classifySurfaceQueryIntent('where am I right now?')).toBe('location');
    expect(classifySurfaceQueryIntent('today weather')).toBe('weather');
  });

  it('extracts web and knowledge search queries', () => {
    expect(extractSurfaceWebSearchQuery('Webで OpenAI Responses API を検索して')).toBe('OpenAI Responses API');
    expect(extractSurfaceKnowledgeQuery('ナレッジで mission authority を調べて')).toBe('mission authority');
  });

  it('loads provider config from knowledge defaults', () => {
    const config = getSurfaceQueryProviderConfig();
    expect(config.web_search?.provider).toBe('duckduckgo_html');
    expect(config.knowledge?.provider).toBe('context_ranker');
  });

  it('merges personal overlay provider settings', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        web_search: {
          enabled: true,
          provider: 'duckduckgo_html',
          maxResults: 3,
          timeoutMs: 5000,
        },
        weather: {
          enabled: true,
          provider: 'open_meteo',
          timeoutMs: 5000,
        },
        location: {
          enabled: true,
          provider: 'presence_context',
        },
        knowledge: {
          enabled: true,
          provider: 'context_ranker',
          limit: 4,
          scope: 'repository',
          phase: 'alignment',
          role: 'presence_surface_agent',
        },
      })
    );
    safeWriteFile(
      overlayPath,
      JSON.stringify({
        weather: {
          provider: 'open_meteo_ch',
        },
        knowledge: {
          limit: 8,
          role: 'executive_assistant',
        },
      })
    );
    process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH = overridePath;
    process.env.KYBERION_PERSONAL_SURFACE_QUERY_CONFIG_PATH = overlayPath;
    resetSurfaceQueryProviderConfigCache();

    const config = getSurfaceQueryProviderConfig();
    expect(config.weather?.provider).toBe('open_meteo_ch');
    expect(config.knowledge?.limit).toBe(8);
    expect(config.knowledge?.role).toBe('executive_assistant');
    expect(config.web_search?.provider).toBe('duckduckgo_html');
  });

  it('loads role overlay provider settings without extra env routing', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        web_search: {
          enabled: true,
          provider: 'duckduckgo_html',
          maxResults: 3,
          timeoutMs: 5000,
        },
        weather: {
          enabled: true,
          provider: 'open_meteo',
          timeoutMs: 5000,
        },
        location: {
          enabled: true,
          provider: 'presence_context',
        },
        knowledge: {
          enabled: true,
          provider: 'context_ranker',
          limit: 4,
          scope: 'repository',
          phase: 'alignment',
          role: 'presence_surface_agent',
        },
      })
    );
    process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH = overridePath;
    resetSurfaceQueryProviderConfigCache();

    const config = getSurfaceQueryProviderConfig({ role: 'presence_surface_agent' });
    expect(config.web_search?.maxResults).toBe(5);
    expect(config.weather?.timeoutMs).toBe(6000);
    expect(config.knowledge?.limit).toBe(6);
    expect(config.knowledge?.role).toBe('presence_surface_agent');
  });

  it('loads role and phase overlay provider settings from knowledge files', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        web_search: {
          enabled: true,
          provider: 'duckduckgo_html',
          maxResults: 3,
          timeoutMs: 5000,
        },
        weather: {
          enabled: true,
          provider: 'open_meteo',
          timeoutMs: 5000,
        },
        location: {
          enabled: true,
          provider: 'presence_context',
        },
        knowledge: {
          enabled: true,
          provider: 'context_ranker',
          limit: 4,
          scope: 'repository',
          phase: 'alignment',
          role: 'presence_surface_agent',
        },
      })
    );
    process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH = overridePath;
    resetSurfaceQueryProviderConfigCache();

    const config = getSurfaceQueryProviderConfig({
      role: 'slack_surface_agent',
      phase: 'alignment',
    });
    expect(config.web_search?.maxResults).toBe(4);
    expect(config.web_search?.timeoutMs).toBe(6500);
    expect(config.weather?.timeoutMs).toBe(6500);
    expect(config.knowledge?.limit).toBe(5);
    expect(config.knowledge?.role).toBe('slack_surface_agent');
    expect(config.knowledge?.phase).toBe('alignment');
  });

  it('loads chronos role overlay alongside alignment phase overlay', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        web_search: {
          enabled: true,
          provider: 'duckduckgo_html',
          maxResults: 3,
          timeoutMs: 5000,
        },
        weather: {
          enabled: true,
          provider: 'open_meteo',
          timeoutMs: 5000,
        },
        location: {
          enabled: true,
          provider: 'presence_context',
        },
        knowledge: {
          enabled: true,
          provider: 'context_ranker',
          limit: 4,
          scope: 'repository',
          phase: 'alignment',
          role: 'presence_surface_agent',
        },
      })
    );
    process.env.KYBERION_SURFACE_QUERY_CONFIG_PATH = overridePath;
    resetSurfaceQueryProviderConfigCache();

    const config = getSurfaceQueryProviderConfig({
      role: 'chronos_surface_agent',
      phase: 'alignment',
    });
    expect(config.web_search?.maxResults).toBe(2);
    expect(config.web_search?.timeoutMs).toBe(7000);
    expect(config.weather?.timeoutMs).toBe(7000);
    expect(config.knowledge?.limit).toBe(3);
    expect(config.knowledge?.role).toBe('chronos_surface_agent');
    expect(config.knowledge?.phase).toBe('chronos');
  });
});
