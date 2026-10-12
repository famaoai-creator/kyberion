import { describe, expect, it } from 'vitest';
import { lyricNormalize, mvStoryboard, buildMvComposeArgs } from './mv-production-ops.js';

describe('lyric_normalize', () => {
  it('katakana-izes known ASCII tokens and falls back letter-by-letter', () => {
    const r = lyricNormalize({ lyrics: 'AI と API で XYZ' });
    expect(r.sing_lyrics).toBe('えーあい と えーぴーあい で えっくすわいずぃー');
    expect(r.conversion_count).toBe(3);
  });
  it('applies reading_overrides for surface forms', () => {
    const r = lyricNormalize({
      lyrics: 'ログの山を読んで',
      reading_overrides: { ログ: 'ろぐ' },
    });
    expect(r.sing_lyrics).toBe('ろぐの山を読んで');
  });
  it('rejects empty lyrics', () => {
    expect(() => lyricNormalize({ lyrics: '  ' })).toThrow('lyrics');
  });
});

const SRT = `1
00:00:20,500 --> 00:00:25,000
最近の AI は えらいもんで

2
00:00:25,000 --> 00:00:30,000
あんなこと こんなこと 調べてくる

3
00:00:30,700 --> 00:00:39,800
ログの山を 一瞬で読んで

4
00:00:40,000 --> 00:00:50,300
こっちは手書きの 防衛線
`;

describe('mv_storyboard', () => {
  it('merges lyric cues into min-length scenes with bookends', () => {
    const r = mvStoryboard({ srt: SRT, duration_sec: 55, min_scene_sec: 5 });
    const scenes = r.scenes as Array<{ start: number; end: number; lyric: string }>;
    expect(scenes[0].lyric).toBe('');
    expect((scenes[0] as { visual?: string }).visual).toContain('establishing');
    expect(scenes[0].end).toBeCloseTo(20.5);
    // first two 4.5-5s cues merge into one ~10s scene
    expect(scenes[1].lyric).toContain('えらいもんで');
    expect(scenes[1].end).toBeCloseTo(30.7);
    expect(scenes.at(-1)!.lyric).toBe('');
    expect(scenes.at(-1)!.end).toBe(55);
    for (const sc of scenes.slice(1, -1)) {
      expect(sc.end - sc.start).toBeGreaterThanOrEqual(5 - 0.001);
    }
  });
});

describe('buildMvComposeArgs', () => {
  it('emits ffmpeg args with concat map and audio mapping', () => {
    const args = buildMvComposeArgs({
      inputs: ['-i', 'a.png', '-i', 'b.png'],
      filterComplex: '[0:v]x[v0];[v0]concat=n=1:v=1:a=0[vbase]',
      audioPath: 'song.mp3',
      audioInputIndex: 2,
      videoLabel: '[vbase]',
      fps: 30,
      outputPath: 'out.mp4',
    });
    expect(args).toContain('-filter_complex');
    expect(args).toContain('out.mp4');
    expect(args[args.indexOf('-map') + 1]).toBe('[vbase]');
    expect(args).toContain('2:a');
  });
});
