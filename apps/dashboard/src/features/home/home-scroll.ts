/**
 * The two decisions a scrolling panel makes, as arithmetic.
 *
 * Both are about the same box — the one `WidgetScroll` puts around a widget's
 * content — and both are the kind of thing that is easy to get subtly wrong and
 * impossible to notice: a header that pins itself out of reach, or a list that
 * yanks itself away from the line you were reading. They live here, apart from
 * the components that apply them, because that makes them testable without a
 * DOM, which is the only kind of test this client has.
 */

/**
 * How much of the box a pinned header must leave behind for the content.
 *
 * Two log lines' worth, at the panel's 10px/relaxed leading. A `position:
 * sticky` block taller than the box it sticks in is a trap rather than a
 * convenience: stuck to the top with nowhere to scroll, its own bottom becomes
 * unreachable — you would lose the log-volume strip, which is the newest thing
 * on it. So pinning is conditional, and this is the condition's margin.
 *
 * Two lines rather than one because a header that leaves room for exactly one
 * line has not really left room for anything: the panel would pin the graph and
 * then show a single line of output under it, which is worse than a panel you
 * can scroll.
 */
export const STICKY_KEEP_PX = 32;

/**
 * Does a header of `blockPx` fit in a box of `boxPx` with room left to read?
 *
 * `boxPx <= 0` is the state before the first measurement — an unmounted or
 * zero-height box — and the answer there is no. Sticking to the top of a box
 * with no height would place the header nowhere in particular, and one pass of
 * unpinned rendering costs nothing to look at.
 */
export function fitsSticky(blockPx: number, boxPx: number): boolean {
  if (boxPx <= 0) return false;
  return blockPx + STICKY_KEEP_PX <= boxPx;
}

/**
 * How close to the bottom still counts as "following the tail".
 *
 * Not zero, for two reasons. Sub-pixel layout means a box scrolled fully down
 * routinely reports a fraction of a pixel short, and an exact test would call
 * that "scrolled up" and stop following. And a user who has nudged the wheel
 * one notch off the bottom has not started reading scrollback — they have
 * jostled it — so a line and a half of slack keeps the panel doing what they
 * were watching it do.
 */
export const PINNED_SLACK_PX = 24;

/**
 * Is the box still showing its own end?
 *
 * This is the whole reason auto-scroll is bearable. A panel that jumps to the
 * newest line *unconditionally* is unreadable the moment a service is chatty:
 * you scroll up to the error, and the next poll throws you back to the bottom.
 * So new output only moves the box when the box was already at the end — which
 * is the reader saying, by not having scrolled, that the end is what they want.
 */
export function isPinned(box: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= PINNED_SLACK_PX;
}
