import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalPath,
  canonicalPathname,
  canonicalUrl,
  PUBLIC_ORIGIN,
  publishedIsoDate,
  renderSitemap,
  sitemapEntries,
} from './seo';

const robotsTxt = readFileSync(fileURLToPath(new URL('../../public/robots.txt', import.meta.url)), 'utf8');
const sitemapXml = readFileSync(fileURLToPath(new URL('../../public/sitemap.xml', import.meta.url)), 'utf8');

describe('canonical URLs', () => {
  it('points every canonical URL at the production origin', () => {
    expect(canonicalUrl('/')).toBe(`${PUBLIC_ORIGIN}/`);
    expect(canonicalUrl('/community')).toBe(`${PUBLIC_ORIGIN}/community`);
  });

  it('strips trailing slashes to avoid duplicate variants', () => {
    expect(canonicalPath('/community/')).toBe('/community');
    expect(canonicalUrl('/chapter/the-dry-pump/')).toBe(`${PUBLIC_ORIGIN}/chapter/the-dry-pump`);
  });

  it('canonicalises /library to the home page', () => {
    expect(canonicalPathname({ name: 'library' })).toBe('/');
    expect(canonicalPathname({ name: 'library' })).toBe(canonicalPathname({ name: 'library', slug: undefined }));
  });

  it('builds chapter and chapter-discussion canonicals from the published slug', () => {
    const chapter = { title: 'THE DRY PUMP' };
    expect(canonicalPathname({ name: 'chapter', slug: 'the-dry-pump', chapter })).toBe('/chapter/the-dry-pump');
    expect(canonicalPathname({ name: 'chapter-thread', slug: 'the-dry-pump', chapter })).toBe(
      '/chapter/the-dry-pump/discussion',
    );
    expect(canonicalPathname({ name: 'community' })).toBe('/community');
  });

  it('gives private, unknown and not-found pages no canonical URL', () => {
    expect(canonicalPathname({ name: 'account' })).toBeNull();
    expect(canonicalPathname({ name: 'moderation' })).toBeNull();
    expect(canonicalPathname({ name: 'not-found' })).toBeNull();
    expect(canonicalPathname({ name: 'chapter', slug: 'the-dry-pump' })).toBeNull();
    expect(canonicalPathname({ name: 'chapter-thread', slug: 'the-dry-pump' })).toBeNull();
    expect(canonicalPathname({ name: 'chapter', slug: 'not-a-real-chapter', chapter: undefined })).toBeNull();
  });

  it('keeps filtered and searched community views, and individual discussions, out of the index', () => {
    // The same discussions appear under many filtered addresses; indexing them
    // all would dilute the one address that matters.
    expect(canonicalPathname({ name: 'community', filtered: true })).toBeNull();
    // A discussion is reader-written, unbounded, and its title can spoil.
    expect(canonicalPathname({ name: 'thread' })).toBeNull();
    expect(canonicalPathname({ name: 'new-discussion' })).toBeNull();
  });
});

describe('published dates', () => {
  it('parses catalog publication labels', () => {
    expect(publishedIsoDate('26 September 2026')).toBe('2026-09-26');
    expect(publishedIsoDate('1 January 2027')).toBe('2027-01-01');
  });

  it('ignores labels it cannot parse', () => {
    expect(publishedIsoDate('forthcoming')).toBeUndefined();
    expect(publishedIsoDate(undefined)).toBeUndefined();
    expect(publishedIsoDate('32 September 2026')).toBeUndefined();
  });
});

describe('public sitemap entries', () => {
  const entries = sitemapEntries();
  const locs = entries.map((e) => e.loc);

  it('lists the home, the community, and every published chapter page and its discussion room', () => {
    expect(locs).toContain(`${PUBLIC_ORIGIN}/`);
    expect(locs).toContain(`${PUBLIC_ORIGIN}/community`);
    expect(locs).toContain(`${PUBLIC_ORIGIN}/chapter/the-dry-pump`);
    expect(locs).toContain(`${PUBLIC_ORIGIN}/chapter/the-dry-pump/discussion`);
    expect(entries.length).toBe(2 + 2 * locs.filter((l) => /\/chapter\/[^/]+$/.test(l)).length);
  });

  it('excludes private, account-management, moderation, API and duplicate routes', () => {
    for (const forbidden of ['/account', '/moderation', '/api', '/library', '/vault', '/session', '/notifications', '/reports']) {
      expect(locs.some((l) => l === `${PUBLIC_ORIGIN}${forbidden}` || l.includes(`${forbidden}/`))).toBe(false);
    }
  });

  it('does not list the retired discussions index, or any address the community filters by', () => {
    // /discussions is a permanent redirect to /community, not a page of its own.
    expect(locs).not.toContain(`${PUBLIC_ORIGIN}/discussions`);
    for (const l of locs) {
      expect(l).not.toMatch(/\/community\/(c|t|new)\//);
      expect(l).not.toMatch(/\?/);
    }
  });

  it('contains only absolute, unique, plain URLs on the production origin', () => {
    expect(new Set(locs).size).toBe(locs.length);
    for (const loc of locs) {
      expect(loc.startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true);
      expect(loc).not.toMatch(/[?#&=]/);
      expect(loc).not.toMatch(/[A-Z]/);
    }
  });

  it('never exposes secrets or private identifiers', () => {
    for (const secret of ['dusk1-', 'auth', 'token', 'secret', 'key', 'cookie', 'session', '@']) {
      expect(locs.join('\n').toLowerCase()).not.toContain(secret);
    }
    for (const entry of entries) {
      if (entry.lastmod) expect(entry.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps sitemap URLs consistent with page canonicals', () => {
    const chapter = { title: 'THE DRY PUMP' };
    for (const path of ['/', '/community', '/chapter/the-dry-pump', '/chapter/the-dry-pump/discussion']) {
      const name = path === '/' ? 'library' : path === '/community' ? 'community' : path.endsWith('/discussion') ? 'chapter-thread' : 'chapter';
      const slug = path.startsWith('/chapter/') ? 'the-dry-pump' : undefined;
      expect(locs).toContain(canonicalUrl(canonicalPathname({ name, slug, chapter })!));
    }
  });
});

describe('committed sitemap.xml', () => {
  it('matches the sitemap rendered from the content source (run `npm run sitemap` after publishing)', () => {
    expect(sitemapXml).toBe(renderSitemap(sitemapEntries()));
  });

  it('is a well-formed sitemap.org urlset document', () => {
    expect(sitemapXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(sitemapXml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapXml.trimEnd().endsWith('</urlset>')).toBe(true);
    const opens = sitemapXml.match(/<url>/g)?.length ?? 0;
    const closes = sitemapXml.match(/<\/url>/g)?.length ?? 0;
    expect(opens).toBeGreaterThan(0);
    expect(opens).toBe(closes);
    for (const loc of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      expect(loc[1].startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true);
    }
    expect(sitemapXml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('committed robots.txt', () => {
  it('allows the public reader and disallows private surfaces', () => {
    expect(robotsTxt).toMatch(/^User-agent: \*$/m);
    expect(robotsTxt).toMatch(/^Allow: \/$/m);
    expect(robotsTxt).toMatch(/^Disallow: \/account$/m);
    expect(robotsTxt).toMatch(/^Disallow: \/moderation$/m);
    expect(robotsTxt).toMatch(/^Disallow: \/api$/m);
    expect(robotsTxt).not.toMatch(/^Disallow: \/$/m);
    expect(robotsTxt).not.toMatch(/^Disallow: \/chapter/m);
    expect(robotsTxt).not.toMatch(/^Disallow: \/community/m);
  });

  it('points at the production sitemap and holds no secrets', () => {
    expect(robotsTxt).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
    for (const secret of ['dusk1-', 'token', 'secret', 'key', 'cookie', 'password']) {
      expect(robotsTxt.toLowerCase()).not.toContain(secret);
    }
  });
});

describe('committed vercel.json', () => {
  const vercel = JSON.parse(readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8'));
  const rewrites: Array<{ source: string; destination: string }> = vercel.rewrites ?? [];

  it('keeps SPA deep links resolvable (guards the cleanUrls + .html destination conflict)', () => {
    // cleanUrls makes /index.html a redirect source; a rewrite destination of
    // /index.html then resolves to nothing and every deep link 404s at the edge.
    const fallback = rewrites.find((r) => r.destination === '/' || /^\/index(\.html)?$/.test(r.destination));
    expect(fallback, 'missing SPA fallback rewrite').toBeDefined();
    if (vercel.cleanUrls) expect(fallback!.destination).not.toMatch(/\.html$/);
    // The API rewrite must be consulted before the SPA fallback.
    const apiIndex = rewrites.findIndex((r) => r.source.startsWith('/api'));
    const fallbackIndex = rewrites.indexOf(fallback!);
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(apiIndex).toBeLessThan(fallbackIndex);
  });

  it('redirects duplicate library/index variants to the canonical root', () => {
    const redirects: Array<{ source: string; destination: string; permanent?: boolean }> = vercel.redirects ?? [];
    expect(redirects).toContainEqual({ source: '/library', destination: '/', permanent: true });
    expect(redirects).toContainEqual({ source: '/index.html', destination: '/', permanent: true });
  });

  it('sends the retired discussions index to the community, so old links and bookmarks land', () => {
    const redirects: Array<{ source: string; destination: string; permanent?: boolean }> = vercel.redirects ?? [];
    expect(redirects).toContainEqual({ source: '/discussions', destination: '/community', permanent: true });
  });

  it('serves robots.txt and sitemap.xml as real files, never the SPA fallback', () => {
    const fallback = rewrites.find((r) => r.destination === '/' || r.destination.endsWith('/index.html'));
    expect(fallback).toBeDefined();
    for (const excluded of ['robots[.]txt', 'sitemap[.]xml', 'api', 'assets']) {
      expect(fallback!.source).toContain(excluded);
    }
  });

  it('sends X-Robots-Tag: noindex for private surfaces', () => {
    const headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> = vercel.headers ?? [];
    for (const path of ['/account', '/moderation', '/api']) {
      const rule = headers.find((h) => h.source === `${path}/:path*`);
      expect(rule, `missing header rule for ${path}`).toBeDefined();
      expect(rule!.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex' });
    }
  });
});
