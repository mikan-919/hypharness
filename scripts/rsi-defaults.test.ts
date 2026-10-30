import { expect, test } from "bun:test";
import { DEFAULTS, resolveSettings } from "./rsi-defaults.ts";

test("a start takes flags, then the previous start's settings, then the defaults", () => {
  expect(resolveSettings(undefined, false, {})).toEqual({ ...DEFAULTS, parallel: undefined, generations: undefined });
  const prev = resolveSettings(undefined, false, { purpose: "p", calls: "50", "eval-calls": "20", parallel: "4" });
  expect(prev).toMatchObject({ purpose: "p", calls: "50", evalCalls: "20", parallel: "4" });
  // A resume keeps the purpose and budgets but not the parallelism or generation limit.
  expect(resolveSettings(prev, true, { mode: "fixed" })).toMatchObject({ purpose: "p", calls: "50", evalCalls: "20", mode: "fixed", parallel: undefined });
});

test("the evaluation's questions and budget are fixed once generations exist", () => {
  const prev = resolveSettings(undefined, false, { "eval-calls": "20" });
  expect(() => resolveSettings(prev, true, { "eval-calls": "30" })).toThrow("fixed at 20");
  expect(() => resolveSettings(prev, true, { seed: "2" })).toThrow("fixed at 1");
  expect(resolveSettings(prev, true, { seed: "1" }).seed).toBe("1");
  expect(() => resolveSettings(prev, true, { arm: "memory" })).toThrow("fixed at dynamic");
  expect(resolveSettings(prev, false, { "eval-calls": "30" }).evalCalls).toBe("30");
});

test("invalid values are refused", () => {
  expect(() => resolveSettings(undefined, false, { mode: "solo" })).toThrow("--mode");
  expect(() => resolveSettings(undefined, false, { calls: "0" })).toThrow("--calls");
  expect(() => resolveSettings(undefined, false, { delta: "2" })).toThrow("--delta");
  expect(() => resolveSettings(undefined, false, { purpose: " " })).toThrow("--purpose");
});
