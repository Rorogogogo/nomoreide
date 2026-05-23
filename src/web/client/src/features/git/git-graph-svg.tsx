export interface GitGraphSvgEdge {
  fromLane: number;
  toLane: number;
}

export interface GitGraphSvgRowProps {
  lane: number;
  laneCount: number;
  edges: GitGraphSvgEdge[];
  throughLanes: number[];
  isMerge: boolean;
  height?: number;
  laneWidth?: number;
}

const LANE_PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#14b8a6", // teal
  "#ef4444", // red
  "#84cc16", // lime
];

export function laneColor(lane: number): string {
  return LANE_PALETTE[lane % LANE_PALETTE.length];
}

/**
 * Renders one row of the commit graph as an inline SVG segment.
 * The dot sits at the row's vertical midpoint in the commit's lane;
 * outgoing edges connect down to each parent's lane at the row's bottom edge.
 * Pass-through lanes draw a full-height vertical line.
 */
export function GitGraphSvgRow({
  lane,
  laneCount,
  edges,
  throughLanes,
  isMerge,
  height = 28,
  laneWidth = 14,
}: GitGraphSvgRowProps) {
  const visibleLanes = Math.max(lane + 1, laneCount, 1);
  const width = visibleLanes * laneWidth;
  const mid = height / 2;
  const dotX = laneX(lane, laneWidth);
  const dotR = isMerge ? 4 : 3.5;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ flex: "0 0 auto", display: "block" }}
    >
      {throughLanes.map((l) => (
        <line
          key={`t-${l}`}
          x1={laneX(l, laneWidth)}
          y1={0}
          x2={laneX(l, laneWidth)}
          y2={height}
          stroke={laneColor(l)}
          strokeWidth={1.5}
        />
      ))}

      {/* Incoming segment: top edge down to the commit dot in this commit's lane. */}
      <line
        x1={dotX}
        y1={0}
        x2={dotX}
        y2={mid}
        stroke={laneColor(lane)}
        strokeWidth={1.5}
      />

      {edges.map((edge, idx) => {
        const x1 = laneX(edge.fromLane, laneWidth);
        const x2 = laneX(edge.toLane, laneWidth);
        if (x1 === x2) {
          return (
            <line
              key={`e-${idx}`}
              x1={x1}
              y1={mid}
              x2={x2}
              y2={height}
              stroke={laneColor(edge.toLane)}
              strokeWidth={1.5}
            />
          );
        }
        const cy = mid + (height - mid) / 2;
        return (
          <path
            key={`e-${idx}`}
            d={`M ${x1} ${mid} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${height}`}
            fill="none"
            stroke={laneColor(edge.toLane)}
            strokeWidth={1.5}
          />
        );
      })}

      <circle
        cx={dotX}
        cy={mid}
        r={dotR}
        fill={laneColor(lane)}
        stroke="var(--background, #fff)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function laneX(lane: number, laneWidth: number): number {
  return lane * laneWidth + laneWidth / 2;
}
