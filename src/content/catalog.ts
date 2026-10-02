/**
 * Chapter catalog: publication metadata only (no prose).
 * Shared by the reader UI and the API so both agree on which chapters exist,
 * their order, and which are published. Add future chapters here and register
 * their prose source in `chapters.ts`.
 */
export type CatalogStatus = 'published' | 'forthcoming' | 'draft';

export type CatalogEntry = {
  slug: string;
  number: number;
  status: CatalogStatus;
  publishedLabel?: string;
  volume?: string;
};

export const catalog: CatalogEntry[] = [
  { slug: 'the-dry-pump', number: 1, status: 'published', publishedLabel: '26 September 2026' },
];

export function publishedCatalog(): CatalogEntry[] {
  return catalog.filter((c) => c.status === 'published').sort((a, b) => a.number - b.number);
}

export function publishedChapterNumber(slug: string): number | undefined {
  return publishedCatalog().find((c) => c.slug === slug)?.number;
}

export function latestPublishedNumber(): number {
  const list = publishedCatalog();
  return list.length ? list[list.length - 1].number : 0;
}

/**
 * Tag a discussion carries when it is about a chapter, e.g. "Chapter 01".
 * Shared by the reader UI, the API and the forum migration so one chapter
 * always produces the same tag.
 */
export function chapterTag(number: number): string {
  return `chapter-${String(number).padStart(2, '0')}`;
}
