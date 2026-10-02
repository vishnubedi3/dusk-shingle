import { describe, expect, it } from 'vitest';
import { cleanText, countUrls, normaliseTags } from './security';

describe('tag normalisation', () => {
  it('reduces anything a reader types to one canonical, URL-safe value', () => {
    expect(normaliseTags(['Kael', 'kael', '  KAEL '])).toEqual(['kael']);
    expect(normaliseTags(['Symbolism', 'world-building', 'Lore & Myth'])).toEqual(['symbolism', 'world-building', 'lore-myth']);
    // The stored form must survive a round trip through a URL path segment.
    for (const tag of normaliseTags(['Chapter 01', 'a b', 'q?uery'])) {
      expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('caps how many tags a discussion can carry, and how long each may be', () => {
    expect(normaliseTags(Array.from({ length: 20 }, (_, i) => `tag${i}`))).toHaveLength(6);
    expect(normaliseTags(['x'.repeat(200)])).toEqual(['x'.repeat(32)]);
  });

  it('drops what cannot become a tag rather than storing noise', () => {
    expect(normaliseTags(['', '   ', '---', '!!!', 42, null])).toEqual([]);
    expect(normaliseTags(undefined)).toEqual([]);
    expect(normaliseTags(null)).toEqual([]);
    expect(() => normaliseTags('kael')).toThrow();
  });
});

describe('text normalisation', () => {
  it('strips control and bidirectional-override characters', () => {
    expect(cleanText('a\u202Eb\u0000c')).toBe('abc');
    expect(cleanText('a\r\n\r\n\r\nb')).toBe('a\n\nb');
  });

  it('counts the links a post may carry', () => {
    expect(countUrls('no links here')).toBe(0);
    expect(countUrls('https://a.test and www.b.test')).toBe(2);
  });
});
