import { describe, expect, it } from 'vitest';
import {
  classifySurfaceQueryIntent,
  extractSurfaceKnowledgeQuery,
  extractSurfaceWebSearchQuery,
  getSurfaceQueryProviderConfig,
  isSurfaceLocationQuery,
  isSurfaceWeatherQuery,
} from './surface-query.js';

describe('surface-query', () => {
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
});
