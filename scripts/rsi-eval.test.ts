import { expect, test } from "bun:test";
import { accept } from "./rsi-eval.ts";

test("a candidate is accepted for a clear score gain or, within the noise band, for a smaller context", () => {
  expect(accept(0.40, 9000, 0.50, 10000, 0.05)).toBe(false); // score fell past the band
  expect(accept(0.60, 10500, 0.50, 10000, 0.05)).toBe(true); // +0.10 score pays for up to 10% more context
  expect(accept(0.60, 11500, 0.50, 10000, 0.05)).toBe(false);
  expect(accept(0.52, 10000, 0.50, 10000, 0.05)).toBe(false); // inside the band without a context cut is noise
  expect(accept(0.47, 9000, 0.50, 10000, 0.05)).toBe(true);
  expect(accept(0.50, 9600, 0.50, 10000, 0.05)).toBe(false); // under 5% is not a cut
});
