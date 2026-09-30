import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandedBounds, headerHeightFromButtons, parkedBounds } from "./layout.ts";

describe("player layout", () => {
  it("keeps the steam menu bar above the page", () => {
    assert.deepEqual(expandedBounds(1280, 800, 52), { x: 0, y: 88, width: 1280, height: 712 });
  });

  it("falls back when the measured header is nonsense", () => {
    assert.equal(expandedBounds(800, 600, 4).y, 48 + 36);
  });

  it("parks a tiny visible spot in the bottom right", () => {
    assert.deepEqual(parkedBounds(1280, 800), { x: 1264, y: 784, width: 4, height: 4 });
  });

  it("uses the lowest top-bar button as the header", () => {
    const height = headerHeightFromButtons([
      { top: 400, bottom: 430, width: 80, height: 30 },
      { top: 4, bottom: 40, width: 90, height: 36 },
      { top: 0, bottom: 28, width: 20, height: 28 },
    ]);
    assert.equal(height, 40);
  });
});
