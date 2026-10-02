import { useEffect, useMemo, useState } from 'react';
import { getAdjacentChapters, getChapterBySlug } from './content/chapters';
import { canonicalPathname, canonicalUrl } from './lib/seo';
import { SiteHeader } from './components/SiteHeader';
import { ReaderProvider, useReader } from './lib/reader';
import { navigateTo } from './lib/navigation';
import { LibraryPage } from './pages/LibraryPage';
import { ChapterPage } from './pages/ChapterPage';
import { CommunityPage } from './pages/CommunityPage';
import { NewDiscussionPage } from './pages/NewDiscussionPage';
import { ChapterThreadPage, ThreadPage } from './pages/ThreadPage';
import { AccountPage } from './pages/AccountPage';
import { ModerationPage } from './pages/ModerationPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** The address bar is the only source of truth: query included, so a filtered or searched list is linkable. */
function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

type Filter = { category?: string; tag?: string; q?: string; scope?: string };

type Route =
  | { name: 'library' }
  | { name: 'chapter'; slug: string }
  | { name: 'community'; filter: Filter }
  | { name: 'new-discussion' }
  | { name: 'thread'; id: string }
  | { name: 'chapter-thread'; slug: string }
  | { name: 'discussions-redirect' }
  | { name: 'account' }
  | { name: 'moderation' }
  | { name: 'not-found' };

function decode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

function matchRoute(rawPath: string, search: string): Route {
  const path = rawPath.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/library') return { name: 'library' };
  // The discussions index became the community; the address still resolves.
  if (path === '/discussions') return { name: 'discussions-redirect' };
  if (path === '/account') return { name: 'account' };
  if (path === '/moderation') return { name: 'moderation' };
  if (path === '/community') return { name: 'community', filter: readFilter(search) };
  if (path === '/community/new') return { name: 'new-discussion' };
  let m = path.match(/^\/community\/c\/([^/]+)$/);
  if (m) return { name: 'community', filter: { category: decode(m[1]) } };
  m = path.match(/^\/community\/t\/([^/]+)$/);
  if (m) return { name: 'community', filter: { tag: decode(m[1]).toLowerCase() } };
  m = path.match(/^\/community\/([^/]+)$/);
  if (m) return { name: 'thread', id: decode(m[1]) };
  m = path.match(/^\/chapter\/([^/]+)\/discussion$/);
  if (m) return { name: 'chapter-thread', slug: decode(m[1]) };
  m = path.match(/^\/chapter\/([^/]+)$/);
  if (m) return { name: 'chapter', slug: decode(m[1]) };
  return { name: 'not-found' };
}

function readFilter(search: string): Filter {
  const params = new URLSearchParams(search);
  const filter: Filter = {};
  for (const key of ['category', 'tag', 'q', 'scope'] as const) {
    const value = params.get(key);
    if (value) filter[key] = value;
  }
  return filter;
}

export default function App() {
  return (
    <ReaderProvider>
      <Shell />
    </ReaderProvider>
  );
}

function Shell() {
  const [url, setUrl] = useState(currentUrl);
  const { prefs } = useReader();
  const pathname = url.split('?')[0] || '/';
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const route = useMemo(() => matchRoute(pathname, search), [pathname, search]);
  const slug = 'slug' in route ? route.slug : undefined;
  const chapter = slug !== undefined ? getChapterBySlug(slug) : undefined;

  useEffect(() => {
    const onPop = () => setUrl(currentUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Keep the address honest even where the edge cannot redirect (local dev).
  useEffect(() => {
    if (route.name === 'discussions-redirect') navigateTo('/community', { replace: true });
  }, [route.name]);

  // Theme: resolve "auto" against the system, and keep it live.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = prefs.theme === 'auto' ? (mql.matches ? 'dusk' : 'paper') : prefs.theme;
      const root = document.documentElement;
      root.dataset.theme = resolved;
      root.dataset.size = prefs.fontSize;
      root.dataset.measure = prefs.measure;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dusk' ? '#121315' : '#f4f1ea');
    };
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [prefs.theme, prefs.fontSize, prefs.measure]);

  useEffect(() => {
    document.title = titleFor(route, chapter);
  }, [route, chapter]);

  // SEO: one canonical URL per indexable public page (kept consistent with
  // sitemap.xml); account, moderation, unknown chapters and not-found carry a
  // noindex meta and no canonical URL.
  useEffect(() => {
    const filtered = 'filter' in route && Object.keys(route.filter).length > 0;
    const path = canonicalPathname({ name: route.name, slug, chapter, filtered });

    let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (path) {
      if (!link) {
        link = document.createElement('link');
        link.rel = 'canonical';
        document.head.appendChild(link);
      }
      link.href = canonicalUrl(path);
    } else {
      link?.remove();
    }

    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (path) {
      meta?.remove();
    } else {
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'robots';
        document.head.appendChild(meta);
      }
      meta.content = 'noindex';
    }
  }, [route, slug, chapter]);

  let page;
  switch (route.name) {
    case 'library': page = <LibraryPage />; break;
    case 'chapter': {
      const adjacent = getAdjacentChapters(route.slug);
      page = <ChapterPage chapter={chapter} previous={adjacent.previous} next={adjacent.next} />;
      break;
    }
    case 'community': page = <CommunityPage filter={route.filter} />; break;
    case 'new-discussion': page = <NewDiscussionPage />; break;
    case 'thread': page = <ThreadPage id={route.id} />; break;
    case 'chapter-thread': page = <ChapterThreadPage chapter={chapter} />; break;
    case 'discussions-redirect': page = <CommunityPage filter={{}} />; break;
    case 'account': page = <AccountPage />; break;
    case 'moderation': page = <ModerationPage />; break;
    default: page = <NotFoundPage />;
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <SiteHeader pathname={pathname} readingTitle={route.name === 'chapter' ? chapter?.title : undefined} />
      {page}
    </div>
  );
}

function titleFor(route: Route, chapter?: { title: string }): string {
  switch (route.name) {
    case 'library': return 'Dusk Shingle — Reader’s library';
    case 'chapter': return chapter ? `${chapter.title} — Dusk Shingle` : 'Chapter unavailable — Dusk Shingle';
    case 'community': return 'Community — Dusk Shingle';
    case 'new-discussion': return 'Start a discussion — Dusk Shingle';
    case 'thread': return 'Discussion — Dusk Shingle';
    case 'chapter-thread': return chapter ? `Discussion: ${chapter.title} — Dusk Shingle` : 'Discussion — Dusk Shingle';
    case 'discussions-redirect': return 'Community — Dusk Shingle';
    case 'account': return 'Account — Dusk Shingle';
    case 'moderation': return 'Moderation — Dusk Shingle';
    default: return 'Not found — Dusk Shingle';
  }
}
