/**
 * The pairing link, as a QR code a phone camera can read.
 *
 * **The encoding is not here.** The daemon does it once, in
 * `nomoreide_core::remote::qr`, and hands over the module grid — so the
 * terminal's `nomoreide remote pair` and this panel draw the same code from
 * one implementation, and neither this app nor the desktop one needs a QR
 * library of its own. What arrives is one string per row, `'1'` for dark.
 *
 * Drawn as a single SVG `<path>` rather than a rectangle per module: a
 * version-6 code is 41×41, and 1,681 elements is a lot of DOM for a picture
 * that never changes. One path of move-and-draw commands renders identically
 * and is one node.
 *
 * **Always dark-on-light, in both themes.** A scanner needs the modules darker
 * than their background, and a code that inverted itself in dark mode is one no
 * phone would read — so the white ground is painted rather than inherited. That
 * is the one place in this app where a colour is deliberately not a token.
 */

export interface QrMatrix {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** One string per row, `'1'` dark and `'0'` light. */
  rows: string[];
}

export function PairingQr({
  matrix,
  label,
}: {
  matrix: QrMatrix;
  label: string;
}) {
  const path = toPath(matrix);
  return (
    <svg
      aria-label={label}
      className="h-44 w-44 rounded border"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
    >
      <rect fill="#ffffff" height={matrix.size} width={matrix.size} x="0" y="0" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/**
 * The dark modules as one path, runs of adjacent modules merged into a single
 * rectangle each. A QR is mostly horizontal runs, so this is a large saving on
 * the path data for no change to what is drawn.
 */
function toPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.rows.length; row += 1) {
    const line = matrix.rows[row] ?? "";
    let start = -1;
    // One past the end, so a run reaching the last column is closed by the
    // same branch that closes every other run rather than by a special case.
    for (let column = 0; column <= line.length; column += 1) {
      const dark = line[column] === "1";
      if (dark && start < 0) {
        start = column;
      } else if (!dark && start >= 0) {
        parts.push(`M${start} ${row}h${column - start}v1h-${column - start}z`);
        start = -1;
      }
    }
  }
  return parts.join("");
}
