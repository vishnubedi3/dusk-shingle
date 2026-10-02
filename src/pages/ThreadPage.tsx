import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Chapter } from '../types';
import { Link } from '../components/Link';
import { Notice } from '../components/Notice';
import { PublicationFooter } from '../components/PublicationFooter';
import { PostItem } from '../components/forum/PostItem';
import { PostComposer } from '../components/forum/PostComposer';
import { SpoilerHint } from '../components/forum/SpoilerHint';
import { SpoilerScope } from '../components/forum/SpoilerScope';
import { useReader } from '../lib/reader';
import { api, ApiFailure } from '../lib/api';
import { chapterNumber } from '../lib/format';
import { publishedChapterNumber } from '../content/catalog';
import { readThrough } from '../lib/spoilers';
import { tagHref, tagLabel, type Post, type Thread } from '../lib/forum';

type Payload = { thread: Thread | null; replies: Post[] };
type State = { state: 'loading' } | { state: 'ready' } | { state: 'error'; error: ApiFailure };
type Opening = { body: string; scope: number; busy: boolean; error?: ApiFailure };

/** A discussion reached by its own address: /community/:id */
export function ThreadPage({ id }: { id?: string }) {
  const load = useCallback(async (): Promise<Payload> => {
    const data = await api<{ thread: Thread; replies: Post[] }>('GET', `/api/forum/threads/${id}`);
    return { thread: data.thread, replies: data.replies };
  }, [id]);
  return <ThreadScreen load={load} address={id} key={id} />;
}

/**
 * A chapter's own discussion, at the URL it has always had. The thread is the
 * community's, reached from the chapter; this route exists so every link ever
 * written to it keeps working.
 */
export function ChapterThreadPage({ chapter }: { chapter?: Chapter }) {
  const slug = chapter?.slug;
  const load = useCallback(async (): Promise<Payload> => {
    const data = await api<{ room: Thread | null; replies: Post[] }>('GET', `/api/forum/threads/chapter/${slug}`);
    return { thread: data.room, replies: data.replies };
  }, [slug]);

  if (!chapter) {
    return (
      <>
        <main id="main" className="standalone page">
          <p className="meta-label">Community</p>
          <h1 className="standalone-title">There is no discussion here.</h1>
          <p className="standalone-text">Discussions exist for the published edition. This chapter is not part of it.</p>
          <Link className="btn btn-secondary" href="/community">Go to the community</Link>
        </main>
        <PublicationFooter />
      </>
    );
  }
  return <ThreadScreen load={load} chapter={chapter} address={slug} key={slug} />;
}

function ThreadScreen({ load, chapter, address }: {
  load: () => Promise<Payload>;
  chapter?: Chapter;
  address?: string;
}) {
  const { account, accountStatus, accountMessage, completedSlugs } = useReader();
  const through = readThrough(completedSlugs, publishedChapterNumber);
  const finished = chapter ? through >= chapter.number : true;
  const gateKey = chapter ? `dusk.gate.${chapter.slug}` : null;

  const [gateOpen, setGateOpen] = useState(() => {
    if (!gateKey) return true;
    try {
      return sessionStorage.getItem(gateKey) === '1';
    } catch {
      return false;
    }
  });
  const [data, setData] = useState<Payload>({ thread: null, replies: [] });
  const [status, setStatus] = useState<State>({ state: 'loading' });
  // A chapter nobody has discussed yet opens on the reader's first post.
  const [opening, setOpening] = useState<Opening>({ body: '', scope: chapter?.number ?? 1, busy: false });

  const thread = data.thread;
  const canPost = Boolean(account);
  const ready = status.state === 'ready';
  const floor = thread?.chapterNumber ?? chapter?.number ?? 1;
  const missing = status.state === 'error' && status.error.status === 404;

  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setStatus({ state: 'ready' });
    } catch (error) {
      setStatus({ state: 'error', error: error as ApiFailure });
    }
  }, [load]);

  useEffect(() => {
    if (finished || gateOpen) void refresh();
  }, [finished, gateOpen, refresh]);

  useEffect(() => {
    if (thread) setOpening((o) => ({ ...o, scope: thread.revealsThrough }));
  }, [thread]);

  // A shared link should say what the discussion is called, not "Discussion".
  useEffect(() => {
    if (!thread) return;
    const where = thread.categoryName;
    document.title = `${thread.title} — ${where} — Dusk Shingle`;
    return () => { document.title = 'Discussion — Dusk Shingle'; };
  }, [thread]);

  function openGate() {
    if (gateKey) {
      try {
        sessionStorage.setItem(gateKey, '1');
      } catch {
        /* private browsing: the gate simply returns next visit */
      }
    }
    setGateOpen(true);
  }

  async function openRoom(event: FormEvent) {
    event.preventDefault();
    setOpening((o) => ({ ...o, busy: true, error: undefined }));
    try {
      await api('POST', `/api/forum/threads/chapter/${chapter?.slug}`, { body: opening.body, revealsThrough: opening.scope });
      setOpening({ body: '', scope: chapter?.number ?? 1, busy: false, error: undefined });
      await refresh();
    } catch (error) {
      setOpening((o) => ({ ...o, busy: false, error: error as ApiFailure }));
    }
  }

  return (
    <>
      <main id="main" className="thread page">
        <Link className="back" href={chapter ? `/chapter/${chapter.slug}` : '/community'}>
          {chapter ? 'Back to the chapter' : 'Back to the community'}
        </Link>
        <header className="discussion-head">
          <p className="meta-label">{subtitleFor(thread, chapter)}</p>
          {ready && (thread || chapter) ? (
            <h1 className="discussion-title">{thread?.title ?? (chapter ? `Chapter ${chapterNumber(chapter.number)}` : '')}</h1>
          ) : ready ? (
            <h1 className="discussion-title">No discussion here</h1>
          ) : (
            <h1 className="discussion-title is-loading" aria-busy="true">&nbsp;</h1>
          )}
          {ready && chapter && <p className="discussion-of">{chapter.title}</p>}
          {ready && <p className="discussion-scope">{blurbFor(thread, Boolean(chapter))}</p>}
          {thread && thread.tags.length > 0 && (
            <p className="thread-tags">
              {thread.tags.map((tag) => (
                <Link key={tag} className="tag" href={tagHref(tag)}>{tagLabel(tag)}</Link>
              ))}
            </p>
          )}
        </header>

        {!finished && !gateOpen ? (
          <div className="gate">
            <p className="gate-title">You haven’t finished this chapter.</p>
            <p>The discussion assumes you have, and may reveal how it ends.</p>
            <div className="gate-actions">
              <Link className="btn btn-primary" href={`/chapter/${chapter?.slug}`}>Return to reading</Link>
              <button type="button" className="btn btn-secondary" onClick={openGate}>Open the discussion anyway</button>
            </div>
          </div>
        ) : (
          <>
            {accountStatus === 'unavailable' && (
              <Notice tone="quiet" title="The community is not connected yet">{accountMessage}</Notice>
            )}

            {status.state === 'loading' && !thread && <p className="meta loading">Loading the discussion…</p>}
            {status.state === 'error' && (
              <Notice
                tone={status.error.code === 'offline' ? 'caution' : 'quiet'}
                title="The discussion could not be loaded"
                action={<button type="button" className="btn btn-quiet" onClick={refresh}>Try again</button>}
              >
                {missing ? `There is no discussion at ${address ? `“${address}”` : 'this address'}. It may have been deleted.` : status.error.message}
              </Notice>
            )}

            {/* Read first, then answer: the discussion opens the page and the
                composer closes it, where reading ends. Nothing is offered
                until the load has settled — otherwise the page would invite a
                reader to open a discussion that already exists. */}
            {ready && thread && (
              <section aria-label="Discussion">
                <PostItem post={thread} thread={thread} readerThrough={through} floor={floor} scope={thread.revealsThrough} onChange={refresh} canPost={canPost} />
                {data.replies.length === 0 ? (
                  <div className="empty">
                    <p className="empty-title">No one has answered yet.</p>
                    <p>{canPost ? 'The first reply sets the tone. Take your time.' : 'When readers begin, their replies will appear here.'}</p>
                  </div>
                ) : (
                  <ol className="replies">
                    {data.replies.map((post) => (
                      <li key={post.id}>
                        <PostItem post={post} readerThrough={through} floor={floor} scope={thread.revealsThrough} onChange={refresh} canPost={canPost} />
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            {ready && account ? (
              thread ? (
                <PostComposer threadId={thread.id} floor={floor} scope={thread.revealsThrough} onPosted={refresh} />
              ) : chapter ? (
                <OpenRoomForm chapter={chapter} opening={opening} onChange={(update) => setOpening((o) => ({ ...o, ...update }))} onSubmit={openRoom} />
              ) : null
            ) : ready && accountStatus === 'signed-out' ? (
              <div className="join">
                <p>To take part, create an anonymous account. No email, no name, no password — you receive a single reader key.</p>
                <Link className="btn btn-secondary" href="/account">Create an anonymous account</Link>
              </div>
            ) : null}
          </>
        )}
      </main>
      <PublicationFooter />
    </>
  );
}

function OpenRoomForm({ chapter, opening, onChange, onSubmit }: {
  chapter: Chapter;
  opening: { body: string; scope: number; busy: boolean; error?: ApiFailure };
  onChange: (update: Partial<{ body: string; scope: number }>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <label className="meta-label" htmlFor="open-room">Open this chapter’s discussion</label>
      <textarea
        id="open-room"
        value={opening.body}
        onChange={(e) => onChange({ body: e.target.value })}
        rows={5}
        maxLength={4000}
        required
        placeholder="What did you make of it?"
        aria-describedby="open-room-hint"
      />
      <div className="composer-foot">
        <div id="open-room-hint">
          <SpoilerScope floor={chapter.number} value={opening.scope} onChange={(scope) => onChange({ scope })} />
          <SpoilerHint />
        </div>
        <div className="composer-actions">
          <button type="submit" className="btn btn-primary" disabled={opening.busy || !opening.body.trim()}>
            {opening.busy ? 'Opening…' : 'Open the discussion'}
          </button>
        </div>
      </div>
      {opening.error && <Notice tone="error">{opening.error.message}</Notice>}
    </form>
  );
}

function subtitleFor(thread: Thread | null, chapter?: Chapter): string {
  if (thread?.isChapterRoom) return `Community · Chapter ${chapterNumber(thread.chapterNumber ?? chapter?.number ?? 1)}`;
  if (thread?.scope === 'chapter') return 'Community · Chapter discussion';
  return 'Community';
}

function blurbFor(thread: Thread | null, isChapter: boolean): string {
  if (thread?.isChapterRoom) return 'The room for this chapter. Everything written here discusses the story up to the end of this chapter.';
  if (!thread && isChapter) return 'Nobody has opened this chapter’s discussion yet. The first note starts it.';
  return 'Anyone can answer. Mark what you found useful, and report anything that spoils without saying so.';
}
