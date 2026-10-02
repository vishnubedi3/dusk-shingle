import { useEffect, useRef, useState } from 'react';
import type { Chapter } from '../types';
import { ChapterBody } from '../components/ChapterBody';
import { ChapterNavigation } from '../components/ChapterNavigation';
import { Link } from '../components/Link';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { PublicationFooter } from '../components/PublicationFooter';
import { PrivateNote } from '../components/PrivateNote';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { useReader } from '../lib/reader';
import { chapterNumber, readingMinutes } from '../lib/format';
import { chapterTag } from '../content/catalog';
import { wordCount } from '../content/chapters';

type Props = { chapter?: Chapter; previous?: Chapter; next?: Chapter };

/** The only progress a screen reader is told about, in quarter-chapter steps. */
const ANNOUNCED = [0.25, 0.5, 0.75, 1];

export function ChapterPage({ chapter, previous, next }: Props) {
  if (!chapter) return <UnavailableChapter />;
  return <ChapterReader key={chapter.slug} chapter={chapter} previous={previous} next={next} />;
}

function ChapterReader({ chapter, previous, next }: Required<Pick<Props, 'chapter'>> & Props) {
  const { vault, recordProgress } = useReader();
  const article = useRef<HTMLDivElement>(null);
  const progress = useReadingProgress(article, chapter.slug);
  const saved = useRef(vault.chapters[chapter.slug]);
  const [resumeOffer, setResumeOffer] = useState(() => {
    const s = saved.current;
    return s && !s.completed && s.progress > 0.03 ? s.progress : 0;
  });
  const lastWrite = useRef(0);
  const state = vault.chapters[chapter.slug];

  // Persist position at most every 1.5s, and always when the chapter is finished.
  useEffect(() => {
    const now = Date.now();
    if (progress < 0.01 && !saved.current) return;
    if (progress >= 0.97 || now - lastWrite.current > 1500) {
      lastWrite.current = now;
      recordProgress(chapter.slug, progress);
      if (resumeOffer && progress > 0.05) setResumeOffer(0);
    }
    // recordProgress identity changes with vault state; progress is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, chapter.slug]);

  function resume() {
    const el = article.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const target = top + resumeOffer * (el.offsetHeight - window.innerHeight * 0.35) - window.innerHeight * 0.65;
    window.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
    setResumeOffer(0);
  }

  const minutes = readingMinutes(wordCount(chapter));
  const pct = Math.round(progress * 100);
  const complete = Boolean(state?.completed) || progress >= 0.97;

  return (
    <>
      <ProgressBar value={progress} />
      <main id="main" className="chapter">
        <header className="prelude" aria-labelledby="chapter-title">
          {/* The chapter number at scale, cropped by the band. Decorative. */}
          <span className="prelude-watermark" aria-hidden="true">{chapterNumber(chapter.number)}</span>
          <div className="prelude-inner">
            <p className="prelude-number">Chapter {chapterNumber(chapter.number)}</p>
            <h1 id="chapter-title" className="prelude-title">{chapter.title}</h1>
            <p className="prelude-meta">
              {chapter.volume && <span>{chapter.volume}</span>}
              {chapter.publishedLabel && <span>Published {chapter.publishedLabel}</span>}
              <span>About {minutes} min</span>
            </p>
          </div>
          <div className="prelude-horizon" aria-hidden="true" />
        </header>

        {resumeOffer > 0 && (
          <div className="resume">
            <button type="button" className="btn btn-quiet" onClick={resume}>
              Resume where you stopped · {Math.round(resumeOffer * 100)}%<Icon name="arrow-right" />
            </button>
            <button type="button" className="icon-btn" onClick={() => setResumeOffer(0)}>
              <Icon name="close" /><span className="visually-hidden">Start from the beginning</span>
            </button>
          </div>
        )}

        <div className="prose-wrap" ref={article}>
          {/* Front matter and a standing progress readout, only where there is
              room beside the column. The same facts are stated in the prelude
              and at the end of the chapter, so this is marked decorative
              rather than announced twice. */}
          <aside className="chapter-rail" aria-hidden="true">
            <span className="rail-numeral">{chapterNumber(chapter.number)}</span>
            <span className="rail-title">{chapter.title}</span>
            <span className="rail-progress"><span className="rail-progress-fill" style={{ transform: `scaleY(${progress})` }} /></span>
            <span className="rail-percent">{pct}%</span>
          </aside>
          <ChapterBody blocks={chapter.blocks} />
        </div>

        <section className="chapter-end" data-complete={complete || undefined} aria-labelledby="chapter-end-title">
          {/* The coda is centred because it is a closing marker, not content.
              Everything after it is left-aligned prose, so the two never share
              a line and the block cannot read as two alignments fighting. */}
          <div className="chapter-coda">
            <div className="end-mark" aria-hidden="true" />
            <h2 id="chapter-end-title" className="meta-label">End of chapter {chapterNumber(chapter.number)}</h2>
            <p className="chapter-end-status">
              {complete ? 'Read' : `${pct}% read`}
            </p>
            {/* Progress is announced in quarters, not continuously: a live region
                that fires on every scroll frame is unusable with a screen reader. */}
            <ProgressAnnouncer progress={progress} />
            <div className="chapter-end-actions">
              {next ? (
                <Link className="btn btn-primary" href={`/chapter/${next.slug}`}>Chapter {chapterNumber(next.number)} · {next.title}<Icon name="arrow-right" /></Link>
              ) : (
                <p className="meta">This is the latest published chapter.</p>
              )}
            </div>
          </div>
          <ChapterDiscussion chapter={chapter} />
          <PrivateNote slug={chapter.slug} />
        </section>

        <ChapterNavigation previous={previous} next={next} />
      </main>
      <PublicationFooter />
    </>
  );
}

function ProgressAnnouncer({ progress }: { progress: number }) {
  const step = ANNOUNCED.reduce((last, s) => (progress >= s ? s : last), 0);
  const label = step === 0 ? 'Not started' : step === 1 ? 'Chapter finished' : `${Math.round(step * 100)}% read`;
  return (
    <p className="visually-hidden" aria-live="polite" aria-atomic="true">{label}</p>
  );
}

function UnavailableChapter() {
  return (
    <main id="main" className="standalone page">
      <p className="meta-label">Not in the edition</p>
      <h1 className="standalone-title">This chapter isn’t here.</h1>
      <p className="standalone-text">It may not be published yet, or the address may be mistyped. Nothing on this site links to unpublished chapters.</p>
      <Link className="btn btn-secondary" href="/"><Icon name="arrow-left" />Return to the library</Link>
    </main>
  );
}

/**
 * The bridge from a chapter into the wider community. It opens that chapter's
 * own discussion — the same thread, whether it was opened from here or from
 * the community — and points onward to everything else readers are discussing.
 */
function ChapterDiscussion({ chapter }: { chapter: Chapter }) {
  return (
    <section className="chapter-discussion" aria-labelledby="chapter-discussion-title">
      <h2 id="chapter-discussion-title" className="meta-label">Community</h2>
      <p className="chapter-discussion-text">
        Chapter {chapterNumber(chapter.number)} has one discussion of its own, and readers write about it alongside
        everything else in the book — theories, characters, the world, questions.
      </p>
      <div className="row-actions">
        <Link className="btn btn-secondary" href={`/chapter/${chapter.slug}/discussion`}>Discuss this chapter</Link>
        <Link className="btn btn-quiet" href={`/community/t/${chapterTag(chapter.number)}`}>Other threads tagged Chapter {chapterNumber(chapter.number)}</Link>
      </div>
    </section>
  );
}
