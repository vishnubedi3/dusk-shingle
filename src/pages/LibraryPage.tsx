import { getPublishedChapters, wordCount } from '../content/chapters';
import { publication } from '../content/publication';
import { Link } from '../components/Link';
import { Icon } from '../components/Icon';
import { PublicationFooter } from '../components/PublicationFooter';
import { TitleNote } from '../components/TitleNote';
import { useReader } from '../lib/reader';
import { chapterNumber, readingMinutes } from '../lib/format';

export function LibraryPage() {
  const chapters = getPublishedChapters();
  const { vault } = useReader();
  const latest = chapters[chapters.length - 1];
  const last = vault.last && chapters.find((c) => c.slug === vault.last!.slug);
  const lastState = last ? vault.chapters[last.slug] : undefined;
  const firstUnread = chapters.find((c) => !vault.chapters[c.slug]?.completed);

  let cta: { href: string; label: string; detail: string } | undefined;
  if (last && lastState && !lastState.completed) {
    cta = { href: `/chapter/${last.slug}`, label: 'Continue reading', detail: `Chapter ${chapterNumber(last.number)} · ${Math.round(lastState.progress * 100)}% read` };
  } else if (firstUnread) {
    const started = Object.keys(vault.chapters).length > 0;
    cta = { href: `/chapter/${firstUnread.slug}`, label: started ? 'Read the next chapter' : 'Begin reading', detail: `Chapter ${chapterNumber(firstUnread.number)} · ${firstUnread.title}` };
  }

  // The masthead sets the name as "Dusk — Shingle" with a hairline between the
  // two words. The library sets the same name at title size, so the wordmark,
  // the title page and the chapter threshold all speak one language. Split on
  // the first space only, and fall back to plain text if the name is one word.
  const [head, ...tail] = publication.title.split(' ');
  const rest = tail.join(' ');

  return (
    <main id="main" className="library">
      <section className="library-intro page" aria-labelledby="library-title">
        <div className="library-head">
          <p className="meta-label">{publication.editionLabel} · {publication.statusLabel}</p>
          <h1 id="library-title" className="library-title">
            {/* The space keeps the accessible name "Dusk Shingle" rather than
                "DuskShingle" once the rule between the two is stripped out. */}
            {rest ? <><span>{head}</span> <i className="library-horizon" aria-hidden="true" /><span>{rest}</span></> : head}
          </h1>
          <p className="library-lede">{publication.description}</p>
          {cta ? (
            <div className="library-cta">
              <Link className="btn btn-primary" href={cta.href}>{cta.label}<Icon name="arrow-right" /></Link>
              <span className="meta">{cta.detail}</span>
            </div>
          ) : chapters.length > 0 ? (
            <p className="library-cta meta">You have read every published chapter. The next will appear here.</p>
          ) : null}
        </div>
      </section>

      <section className="contents page" aria-labelledby="contents-title">
        <div className="section-head">
          <h2 id="contents-title" className="meta-label">Contents</h2>
          <span className="meta">{chapters.length} published{latest ? ` · latest ${latest.publishedLabel ?? `chapter ${chapterNumber(latest.number)}`}` : ''}</span>
        </div>
        {chapters.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nothing has been published yet.</p>
            <p>Chapters will take their place here as they are released.</p>
          </div>
        ) : (
          <ol className="toc">
            {chapters.map((chapter) => {
              const state = vault.chapters[chapter.slug];
              const status = state?.completed ? 'Read' : state && state.progress > 0.01 ? `${Math.round(state.progress * 100)}%` : 'Unread';
              return (
                <li key={chapter.slug}>
                  <Link className="toc-row" href={`/chapter/${chapter.slug}`} data-state={state?.completed ? 'read' : state ? 'started' : 'unread'}>
                    <span className="toc-num">{chapterNumber(chapter.number)}</span>
                    <span className="toc-title">
                      {chapter.title}
                      {chapter === latest && chapters.length > 1 && <span className="toc-flag">Latest</span>}
                    </span>
                    <span className="toc-meta">{chapter.publishedLabel} · {readingMinutes(wordCount(chapter))} min</span>
                    <span className="toc-status">
                      {state?.completed && <Icon name="check" size={14} />}
                      <span className="visually-hidden">Status: </span>{status}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <TitleNote />
      <PublicationFooter showTitleNote={false} />
    </main>
  );
}
