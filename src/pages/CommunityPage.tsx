import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from '../components/Link';
import { Notice } from '../components/Notice';
import { PublicationFooter } from '../components/PublicationFooter';
import { ThreadList } from '../components/forum/ThreadList';
import { useReader } from '../lib/reader';
import { api, ApiFailure } from '../lib/api';
import { navigateTo } from '../lib/navigation';
import { chapterNumber, relativeTime } from '../lib/format';
import { getChapterBySlug } from '../content/chapters';
import { publishedChapterNumber } from '../content/catalog';
import { readThrough } from '../lib/spoilers';
import {
  categoryHref, discussionCount, replyCount, tagHref, tagLabel, threadHref,
  type ForumIndex, type ThreadSummary,
} from '../lib/forum';

const PAGE = 20;

type Filter = { category?: string; tag?: string; q?: string; scope?: string };

/**
 * The community. With no filter it is a landing page: what readers are writing
 * about, and where to begin. With a filter it is a browsable, pageable list.
 */
export function CommunityPage({ filter }: { filter: Filter }) {
  const { account, completedSlugs } = useReader();
  const through = readThrough(completedSlugs, publishedChapterNumber);
  const browsing = Boolean(filter.category || filter.tag || filter.q || filter.scope);

  return (
    <>
      <main id="main" className="community page">
        <header className="community-head">
          <p className="meta-label">Community</p>
          <h1 className="standalone-title">
            {filter.category ? 'A category' : filter.tag ? tagLabel(filter.tag) : filter.q ? `“${filter.q}”` : filter.scope === 'chapter' ? 'Chapter discussions' : filter.scope === 'community' ? 'Everything else' : 'A place to talk about the book.'}
          </h1>
          <p className="standalone-text">
            {browsing
              ? 'Discussions matching what you asked for.'
              : 'Theories, characters, world, questions, and anything else the book leaves room for. No account beyond a reader key, no followers, no feed — just the conversations.'}
          </p>
          <div className="library-cta">
            <Link className="btn btn-primary" href="/community/new">Start a discussion</Link>
            {!account && <Link className="btn btn-secondary" href="/account">Create an anonymous account</Link>}
          </div>
        </header>

        {browsing ? (
          <Browse filter={filter} readerThrough={through} />
        ) : (
          <Landing readerThrough={through} />
        )}
      </main>
      <PublicationFooter />
    </>
  );
}

function Landing({ readerThrough }: { readerThrough: number }) {
  const [data, setData] = useState<ForumIndex>();
  const [error, setError] = useState<ApiFailure>();

  useEffect(() => {
    api<ForumIndex>('GET', '/api/forum')
      .then(setData)
      .catch((e) => setError(e as ApiFailure));
  }, []);

  if (error) {
    return <Notice tone="quiet" title="The community could not be loaded" action={<button type="button" className="btn btn-quiet" onClick={() => window.location.reload()}>Try again</button>}>{error.message}</Notice>;
  }
  if (!data) return <p className="meta loading">Loading the community…</p>;

  const chapters = data.chapterRooms.filter((room) => room.discussions > 0 || room.id);

  return (
    <>
      <SearchBox />

      <section className="community-section" aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="meta-label">Categories</h2>
        <ul className="category-grid">
          {data.categories.map((category) => (
            <li key={category.slug}>
              <Link className="category-card" href={categoryHref(category.slug)}>
                <span className="category-name">{category.name}</span>
                {category.description && <span className="category-text">{category.description}</span>}
                <span className="category-count">{discussionCount(category.discussions)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="community-section" aria-labelledby="latest-heading">
        <h2 id="latest-heading" className="meta-label">Latest discussions</h2>
        <ThreadList
          threads={data.latest}
          readerThrough={readerThrough}
          empty="Nobody has started a discussion yet."
        />
      </section>

      {data.active.length > 0 && (
        <section className="community-section" aria-labelledby="active-heading">
          <h2 id="active-heading" className="meta-label">Most active</h2>
          <ThreadList threads={data.active} readerThrough={readerThrough} />
        </section>
      )}

      <section className="community-section" aria-labelledby="chapters-heading">
        <h2 id="chapters-heading" className="meta-label">Chapter discussions</h2>
        {chapters.length === 0 ? (
          <p className="meta empty-line">No chapter has been discussed yet.</p>
        ) : (
          <ol className="chapter-list">
            {chapters.map((room) => {
              const title = getChapterBySlug(room.slug)?.title ?? room.title ?? '';
              return (
                <li key={room.slug}>
                  <Link className="chapter-row" href={room.id ? threadHref({ id: room.id, isChapterRoom: true, chapterSlug: room.slug }) : `/chapter/${room.slug}/discussion`}>
                    <span className="chapter-num">Chapter {chapterNumber(room.number)}</span>
                    <span className="chapter-title">{title}</span>
                    <span className="chapter-meta">
                      {room.discussions === 0 ? 'Not opened yet' : `${discussionCount(room.discussions)} · ${replyCount(room.replies)}`}
                      {room.latest && ` · ${relativeTime(room.latest)}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {data.tags.length > 0 && (
        <section className="community-section" aria-labelledby="tags-heading">
          <h2 id="tags-heading" className="meta-label">Tagged threads</h2>
          <p className="thread-tags">
            {data.tags.map(({ tag, discussions }) => (
              <Link key={tag} className="tag" href={tagHref(tag)}>
                {tagLabel(tag)} <span className="count">{discussions}</span>
              </Link>
            ))}
          </p>
        </section>
      )}
    </>
  );
}

function Browse({ filter, readerThrough }: { filter: Filter; readerThrough: number }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<{ state: 'loading' } | { state: 'ready' } | { state: 'error'; error: ApiFailure }>({ state: 'loading' });

  const query = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filter.category) params.set('category', filter.category);
    if (filter.tag) params.set('tag', filter.tag);
    if (filter.q) params.set('q', filter.q);
    if (filter.scope) params.set('scope', filter.scope);
    return `/api/forum/threads?${params}`;
  }, [filter.category, filter.q, filter.scope, filter.tag]);

  const load = useCallback(async (offset: number) => {
    setStatus({ state: 'loading' });
    try {
      const data = await api<{ threads: ThreadSummary[]; hasMore: boolean }>('GET', query(offset));
      setThreads((current) => (offset === 0 ? data.threads : [...current, ...data.threads]));
      setHasMore(data.hasMore);
      setStatus({ state: 'ready' });
    } catch (error) {
      setStatus({ state: 'error', error: error as ApiFailure });
    }
  }, [query]);

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <>
      <SearchBox initial={filter.q} />
      {status.state === 'error' && (
        <Notice tone="quiet" title="Discussions could not be loaded" action={<button type="button" className="btn btn-quiet" onClick={() => void load(0)}>Try again</button>}>
          {status.error.message}
        </Notice>
      )}
      {status.state === 'loading' && threads.length === 0 && <p className="meta loading">Loading…</p>}
      {status.state === 'ready' && <ThreadList threads={threads} readerThrough={readerThrough} empty="Nothing here yet. Be the first to write about it." />}
      {status.state === 'ready' && hasMore && (
        <div className="load-more">
          <button type="button" className="btn btn-secondary" onClick={() => void load(threads.length)}>
            Load more
          </button>
        </div>
      )}
      {status.state === 'loading' && threads.length > 0 && <p className="meta loading">Loading…</p>}
      <p className="back-to-top"><Link className="btn btn-quiet" href="/community">All discussions</Link></p>
    </>
  );
}

function SearchBox({ initial }: { initial?: string }) {
  const [value, setValue] = useState(initial ?? '');
  return (
    <form className="search" role="search" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      const q = value.trim();
      navigateTo(q ? `/community?q=${encodeURIComponent(q)}` : '/community');
    }}>
      <label className="visually-hidden" htmlFor="community-search">Search discussions</label>
      <input
        id="community-search"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={80}
        placeholder="Search titles and text"
      />
      <button type="submit" className="btn btn-secondary">Search</button>
    </form>
  );
}
