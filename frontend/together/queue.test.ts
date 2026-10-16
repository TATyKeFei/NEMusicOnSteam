import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { roomQueueTools, ROOM_QUEUE_HELPER } from "./queue.ts";

describe("together queue normalization", () => {
  it("normalizes all supported track shapes and preserves order without duplicates", () => {
    const queue = [1, "2", { id: 3 }, { trackId: 4 }, { resourceId: 5 }, { songId: 6 },
      { track: { id: 7 } }, { songInfo: { trackId: 8 } }, { song: { id: 9 } }, "1", null, {}, -1, 1.5, "bad"];
    const expected = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    assert.deepEqual(roomQueueTools().songIds(queue), expected);
    assert.deepEqual(Array.from(runInNewContext(`${ROOM_QUEUE_HELPER}; songIds(queue)`, { queue })), expected);
  });

  it("skips invalid leading arrays before selecting a usable queue", () => {
    const slice = { displayTrackIds: [{ invalid: true }], tracks: [{ trackId: 7 }, { song: { id: 8 } }] };
    assert.deepEqual(roomQueueTools().roomQueueOf(slice), ["7", "8"]);
    assert.deepEqual(Array.from(runInNewContext(`${ROOM_QUEUE_HELPER}; roomQueueOf(slice)`, { slice })), ["7", "8"]);
  });
});
