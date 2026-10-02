/**
 * Community forum: the shapes the API returns, and the small amount of shared
 * knowledge the reader needs to make sense of them. Categories and tags live
 * in the database (see server/migrate.ts), not here — this module knows how to
 * label them, not what they are.
 */
import { chapterTag } from '../content/catalog';

export type Scope = 'community' | 'chapter';

export type Category = {
  slug: string;
  name: string;
  description: string;
  discussions: number;
};

export type ChapterRoom = {
  slug: string;
  number: number;
  /** Null until a reader opens the chapter's discussion. */
  id: string | null;
  title: string | null;
  discussions: number;
  replies: number;
  latest: string | null;
};

/** A discussion as a reply looks: no title, category, tags or chapter. */
export type Post = {
  id: string;
  parentId: string | null;
  author: string | null;
  body: string;
  status: 'visible' | 'hidden' | 'removed' | 'deleted';
  revealsThrough: number;
  hasSpoiler: boolean;
  createdAt: string;
  editedAt: string | null;
  reactions: number;
  reacted: boolean;
  mine: boolean;
};

export type Thread = Post & {
  scope: Scope;
  title: string;
  category: string;
  categoryName: string;
  chapterSlug: string | null;
  chapterNumber: number | null;
  tags: string[];
  isChapterRoom: boolean;
  replies: number;
  lastActivityAt: string;
};

/** A listing row: the thread without its body, so the index cannot leak spoilers. */
export type ThreadSummary = Omit<Thread, 'body'>;

export type ForumIndex = {
  categories: Category[];
  latest: ThreadSummary[];
  active: ThreadSummary[];
  chapterRooms: ChapterRoom[];
  tags: { tag: string; discussions: number }[];
  total: number;
};

/** Canonical link for a discussion: a chapter's room keeps the URL it always had. */
export const threadHref = (thread: { id: string; isChapterRoom?: boolean; chapterSlug?: string | null }): string =>
  thread.isChapterRoom && thread.chapterSlug ? `/chapter/${thread.chapterSlug}/discussion` : `/community/${thread.id}`;

export const categoryHref = (slug: string) => `/community/c/${encodeURIComponent(slug)}`;
export const tagHref = (tag: string) => `/community/t/${encodeURIComponent(tag)}`;

/**
 * Tags are stored normalised (`kael`, `chapter-01`), so the display label is
 * derived. Chapter tags read as chapters because that is how the reader has
 * always been told to refer to them.
 */
export function tagLabel(tag: string): string {
  const chapter = /^chapter-(\d+)$/.exec(tag);
  if (chapter) return `Chapter ${chapter[1]}`;
  return tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, ' ');
}

export function isChapterTag(tag: string): boolean {
  return /^chapter-\d+$/.test(tag);
}

export { chapterTag };

/** "3 replies" / "1 reply" / "no replies yet" */
export const replyCount = (n: number) => (n === 1 ? '1 reply' : n === 0 ? 'no replies yet' : `${n} replies`);

export const discussionCount = (n: number) => (n === 1 ? '1 discussion' : `${n} discussions`);
