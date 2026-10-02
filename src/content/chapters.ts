import type { Chapter, ChapterBlock } from '../types';
import { catalog } from './catalog';
import chapterOneMarkdown from './chapters/chapter-001.md?raw';

/** Prose sources keyed by slug. Register each new chapter's source here. */
const sources: Record<string, string> = {
  'the-dry-pump': chapterOneMarkdown,
};

/**
 * Parse only the prose section after the source document's metadata divider.
 * A leading `---…---` block is YAML frontmatter (title, dates, tags) and is
 * dropped before anything else; without that, the frontmatter's own lines are
 * indistinguishable from the first paragraphs of the chapter and reach readers.
 */
function parsePublishedProse(markdown: string): ChapterBlock[] {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const prose = body.split(/^---\s*$/m).slice(1).join('\n---\n');
  return prose
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((text) => ({ type: 'paragraph', text }));
}

function parseTitle(markdown: string): string | undefined {
  return markdown.match(/^#\s+CHAPTER\s+\d+\s+—\s+(.+)$/m)?.[1]?.trim();
}

/** Public publication source: only explicitly published reader-ready material belongs here. */
export const chapters: Chapter[] = catalog
  .filter((entry) => sources[entry.slug])
  .map((entry) => {
    const source = sources[entry.slug];
    return {
      slug: entry.slug,
      number: entry.number,
      title: parseTitle(source) ?? `Chapter ${entry.number}`,
      volume: entry.volume,
      publishedLabel: entry.publishedLabel,
      status: entry.status,
      blocks: parsePublishedProse(source),
    };
  });

export function getPublishedChapters(): Chapter[] {
  return chapters
    .filter((chapter) => chapter.status === 'published')
    .sort((a, b) => a.number - b.number);
}

export function getChapterBySlug(slug: string): Chapter | undefined {
  return getPublishedChapters().find((chapter) => chapter.slug === slug);
}

export function getAdjacentChapters(slug: string): { previous?: Chapter; next?: Chapter } {
  const published = getPublishedChapters();
  const index = published.findIndex((chapter) => chapter.slug === slug);
  if (index === -1) return {};
  return { previous: published[index - 1], next: published[index + 1] };
}

export function wordCount(chapter: Chapter): number {
  return chapter.blocks.reduce((n, b) => n + ('text' in b ? b.text.split(/\s+/).length : 0), 0);
}
