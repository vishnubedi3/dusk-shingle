import { useId } from 'react';
import { getPublishedChapters } from '../../content/chapters';
import { chapterNumber } from '../../lib/format';

/**
 * How far into the published edition a post reaches. A reader who has not got
 * that far sees the post folded; one who has, sees it whole. Wrapping a span
 * in ||double bars|| conceals it either way, until it is asked for.
 */
export function SpoilerScope({ floor, value, onChange, hint }: {
  floor: number;
  value: number;
  onChange: (chapter: number) => void;
  hint?: string;
}) {
  const id = useId();
  const options = getPublishedChapters().filter((c) => c.number >= floor);
  if (options.length <= 1) {
    return <p className="field-hint">{hint ?? `Discusses up to chapter ${chapterNumber(floor)}.`}</p>;
  }
  return (
    <div className="scope">
      <label htmlFor={id} className="field-hint">Discusses up to</label>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((c) => (
          <option key={c.slug} value={c.number}>
            Chapter {chapterNumber(c.number)}{c.number === floor ? ' (this chapter)' : ' — folded for readers who haven’t reached it'}
          </option>
        ))}
      </select>
    </div>
  );
}
