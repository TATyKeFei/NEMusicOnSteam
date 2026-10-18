import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderQueue, parseCamelot } from "./queue-order.ts";

function track(id: string, bpm: number | null, key: string | null = null, energy: number | null = null) {
  return { id, bpm, key, energy };
}

describe("playlist ordering", () => {
  it("parses camelot codes and rejects nonsense", () => {
    assert.deepEqual(parseCamelot("8B"), { position: 8, minor: false });
    assert.deepEqual(parseCamelot(" 12a "), { position: 12, minor: true });
    for (const value of ["", "0A", "13B", "8C", "B8", null]) assert.equal(parseCamelot(value), null);
  });

  it("chains neighbors by tempo so the order never jumps", () => {
    const order = orderQueue([track("a", 90), track("b", 140), track("c", 92)]);
    assert.deepEqual(order, ["a", "c", "b"]);
  });

  it("prefers the smallest combined tempo, key and energy step", () => {
    // 从 a 出发：d 的调性相邻、速度也近；b 只有速度近、调性隔得远。
    const order = orderQueue([
      track("a", 120, "8B", 0.4),
      track("b", 122, "3A", 0.9),
      track("d", 121, "9B", 0.45),
    ]);
    assert.deepEqual(order, ["a", "d", "b"]);
  });

  it("treats relative keys as a smooth step", () => {
    const order = orderQueue([
      track("a", 120, "8A"),
      track("b", 120, "2B"),
      track("c", 120, "8B"),
    ]);
    assert.deepEqual(order, ["a", "c", "b"]);
  });

  it("keeps unknown tracks in their original order at the end", () => {
    const order = orderQueue([track("a", 100), track("x", null), track("b", 101), track("y", null)]);
    assert.deepEqual(order, ["a", "b", "x", "y"]);
  });

  it("keeps the first analyzed track as the chain head", () => {
    const order = orderQueue([track("x", null), track("a", 100), track("b", 200)]);
    assert.deepEqual(order, ["a", "b", "x"]);
  });

  it("does not touch the list when there is nothing to chain", () => {
    const single = [track("a", 100), track("b", null), track("c", null)];
    assert.deepEqual(orderQueue(single), ["a", "b", "c"]);
    const none = [track("a", null), track("b", null)];
    assert.deepEqual(orderQueue(none), ["a", "b"]);
    assert.deepEqual(orderQueue([]), []);
    assert.deepEqual(orderQueue([track("a", 100)]), ["a"]);
  });

  it("preserves duplicates by count", () => {
    const order = orderQueue([track("a", 100), track("b", 101), track("a", 100)]);
    assert.equal(order.length, 3);
    assert.deepEqual([...order].sort(), ["a", "a", "b"]);
  });
});
