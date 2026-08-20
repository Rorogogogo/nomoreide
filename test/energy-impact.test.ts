import { describe, expect, test } from "vitest";
import { estimateEnergyImpact } from "../apps/dashboard/src/features/activity/energy-impact.js";

describe("estimated energy impact", () => {
  test("combines CPU with a smaller memory-pressure signal", () => {
    expect(estimateEnergyImpact(5, 10)).toEqual({ level: "low", score: 7.5 });
    expect(estimateEnergyImpact(20, 20)).toEqual({ level: "medium", score: 25 });
    expect(estimateEnergyImpact(60, 10)).toEqual({ level: "high", score: 62.5 });
  });

  test("clamps the relative score to a 0-100 range", () => {
    expect(estimateEnergyImpact(-10, -5).score).toBe(0);
    expect(estimateEnergyImpact(150, 100).score).toBe(100);
  });
});
