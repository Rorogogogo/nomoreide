import { describe, expect, test } from "vitest";
import { metricPressure } from "../src/web/client/src/features/activity/metric-pressure";

describe("activity metric pressure", () => {
  test("maps low, medium, and high utilization at stable boundaries", () => {
    expect(metricPressure(null)).toBeNull();
    expect(metricPressure(0)).toBe("low");
    expect(metricPressure(29.9)).toBe("low");
    expect(metricPressure(30)).toBe("medium");
    expect(metricPressure(69.9)).toBe("medium");
    expect(metricPressure(70)).toBe("high");
    expect(metricPressure(120)).toBe("high");
  });
});
