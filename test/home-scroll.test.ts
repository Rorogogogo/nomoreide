import { describe, expect, test } from "vitest";
import {
  fitsSticky,
  isPinned,
  PINNED_SLACK_PX,
  STICKY_KEEP_PX,
} from "../src/web/client/src/features/home/home-scroll";

/**
 * The Logs panel's two scroll decisions.
 *
 * Both are invisible when right and confusing when wrong — a graph pinned out of
 * reach, or a panel that yanks itself away from the line being read — and
 * neither is reachable from a test that has no DOM. Which is why they are
 * arithmetic in the first place.
 */

describe("fitsSticky", () => {
  test("pins only when the content still has room to be read", () => {
    // Exactly the margin is enough: the condition is "leaves room", not "leaves
    // more than room".
    expect(fitsSticky(100, 100 + STICKY_KEEP_PX)).toBe(true);
    expect(fitsSticky(100, 100 + STICKY_KEEP_PX + 40)).toBe(true);
    // One pixel short of two lines' room and the pin stops being a kindness.
    expect(fitsSticky(100, 100 + STICKY_KEEP_PX - 1)).toBe(false);
  });

  test("refuses a header taller than its own box", () => {
    // The trap this guard exists for: stuck to the top with nowhere to scroll,
    // the bottom of the block — the newest pane on it — is unreachable.
    expect(fitsSticky(220, 140)).toBe(false);
  });

  test("refuses a box that has not been measured yet", () => {
    expect(fitsSticky(0, 0)).toBe(false);
    expect(fitsSticky(120, 0)).toBe(false);
  });
});

describe("isPinned", () => {
  test("a box scrolled to its end is following the tail", () => {
    expect(isPinned({ clientHeight: 200, scrollHeight: 600, scrollTop: 400 })).toBe(true);
  });

  test("sub-pixel and one-notch slack still count as the end", () => {
    // A box scrolled fully down routinely reports a fraction short; an exact
    // test would call that "scrolled up" and quietly stop following.
    expect(isPinned({ clientHeight: 200, scrollHeight: 600, scrollTop: 399.5 })).toBe(true);
    expect(
      isPinned({ clientHeight: 200, scrollHeight: 600, scrollTop: 400 - PINNED_SLACK_PX }),
    ).toBe(true);
  });

  test("a reader who has scrolled up is left alone", () => {
    expect(
      isPinned({ clientHeight: 200, scrollHeight: 600, scrollTop: 400 - PINNED_SLACK_PX - 1 }),
    ).toBe(false);
    expect(isPinned({ clientHeight: 200, scrollHeight: 600, scrollTop: 0 })).toBe(false);
  });

  test("a box with nothing to scroll is at its end", () => {
    // An unsized panel fits its content, so there is no 'away from the bottom'
    // to be at — and new output should still land visible.
    expect(isPinned({ clientHeight: 200, scrollHeight: 200, scrollTop: 0 })).toBe(true);
  });
});
