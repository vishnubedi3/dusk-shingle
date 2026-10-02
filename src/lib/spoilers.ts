/** Parse untrusted comment text into safe render segments. No HTML is ever produced or interpreted. */
export type Segment = { kind: 'text' | 'spoiler'; text: string };

export function parseCommentBody(body: string): Segment[][] {
  return body.split(/\n{2,}/).map((para) => {
    const out: Segment[] = [];
    const re = /\|\|([^|]+)\|\|/g;
    let last = 0;
    for (let m = re.exec(para); m; m = re.exec(para)) {
      if (m.index > last) out.push({ kind: 'text', text: para.slice(last, m.index) });
      out.push({ kind: 'spoiler', text: m[1] });
      last = m.index + m[0].length;
    }
    if (last < para.length) out.push({ kind: 'text', text: para.slice(last) });
    return out;
  });
}

/** Highest chapter number the reader has finished, given completion by slug. */
export function readThrough(completedSlugs: string[], numberOf: (slug: string) => number | undefined): number {
  return completedSlugs.reduce((max, slug) => Math.max(max, numberOf(slug) ?? 0), 0);
}

/**
 * A post is folded when it reaches past what the reader has finished, or past
 * the thread's own declared scope. Taking the larger of the two is what stops a
 * reader who has finished nothing from having every thread hidden: a discussion
 * that declares it stays inside chapter 1 is visible to everyone, because that
 * is the floor the author agreed to, and a chapter's own room is visible to
 * everyone because the chapter gate has already asked its question.
 */
export const isFolded = (revealsThrough: number, readerThrough: number, scopeFloor: number) =>
  revealsThrough > Math.max(readerThrough, scopeFloor);

/** The lowest chapter a discussion may reach: its own chapter, or the first one. */
export const scopeFloorOf = (chapterNumber: number | null): number => chapterNumber ?? 1;
