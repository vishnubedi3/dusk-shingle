import { getPublishedChapters } from '../content/chapters';

/**
 * Public URL discovery: canonical URLs and the sitemap, both derived from the
 * published content source in `src/content/`. Used by the reader (document
 * canonical/robots metadata) and by `scripts/generate-sitemap.ts` (build-time
 * sitemap), so the two can never disagree.
 */

/** Canonical production origin. Every canonical and sitemap URL is absolute against this host. */
export const PUBLIC_ORIGIN = 'https://dusk-shingle.vercel.app';

/** Canonical form of a pathname: no trailing slash, except the root itself. */
export function canonicalPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Absolute canonical URL for a pathname. */
export function canonicalUrl(path: string): string {
  const pathPart = canonicalPath(path);
  return pathPart === '/' ? `${PUBLIC_ORIGIN}/` : `${PUBLIC_ORIGIN}${pathPart}`;
}

/**
 * Canonical pathname for a rendered app route, or null when the page must not
 * carry a canonical URL and must not be indexed.
 *
 * Two decisions worth stating. The community index is indexed; a *filtered* or
 * searched view is not, because the same discussions appear under many such
 * addresses. Individual discussions are not indexed either — they are
 * user-written, unbounded in number, and a title can spoil. They are still
 * linkable and shareable; they are simply not handed to a crawler.
 */
export function canonicalPathname(route: {
  name: string;
  slug?: string;
  chapter?: unknown;
  filtered?: boolean;
}): string | null {
  switch (route.name) {
    case 'library':
      // /library is a duplicate variant of the home page; both canonicalise to /.
      return '/';
    case 'community':
      return route.filtered ? null : '/community';
    case 'chapter':
      return route.slug && route.chapter ? `/chapter/${encodeURIComponent(route.slug)}` : null;
    case 'chapter-thread':
      return route.slug && route.chapter ? `/chapter/${encodeURIComponent(route.slug)}/discussion` : null;
    default:
      return null;
  }
}

export type SitemapEntry = {
  loc: string;
  /** ISO date (YYYY-MM-DD) when the content source knows the publication date. */
  lastmod?: string;
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Parse a catalog `publishedLabel` such as "26 September 2026" into "2026-09-26". */
export function publishedIsoDate(label: string | undefined): string | undefined {
  const m = label?.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return undefined;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return undefined;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return undefined;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Every canonical, publicly indexable URL, derived from the published chapters
 * in the content source. Private surfaces (account, moderation, API), duplicate
 * variants (/library), the filtered community views, individual discussions,
 * drafts and unpublished catalog entries are excluded by construction.
 */
export function sitemapEntries(): SitemapEntry[] {
  const chapters = getPublishedChapters();
  const dates = chapters.map((c) => publishedIsoDate(c.publishedLabel)).filter((d): d is string => Boolean(d));
  const latest = dates.length > 0 ? dates.sort().at(-1) : undefined;

  const entries: SitemapEntry[] = [
    { loc: canonicalUrl('/'), lastmod: latest },
    { loc: canonicalUrl('/community') },
    ...chapters.map((c): SitemapEntry => ({ loc: canonicalUrl(`/chapter/${c.slug}`), lastmod: publishedIsoDate(c.publishedLabel) })),
    ...chapters.map((c): SitemapEntry => ({ loc: canonicalUrl(`/chapter/${c.slug}/discussion`) })),
  ];
  return entries.map(({ loc, lastmod }) => (lastmod ? { loc, lastmod } : { loc }));
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return ch;
    }
  });
}

/** Render sitemap entries as a sitemap.org 0.9 urlset document. */
export function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
