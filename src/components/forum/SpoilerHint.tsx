/** The spoiler convention, stated once, wherever a reader is asked to type. */
export function SpoilerHint({ id }: { id?: string }) {
  return <p id={id} className="field-hint">Wrap spoilers in <code>||double bars||</code>. Plain text only; links are not clickable.</p>;
}
