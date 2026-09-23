import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlayerDocument, PLAYER_URL } from "./constants.ts";

describe("player url", () => {
  it("recognizes the official web player and its query string", () => {
    assert.equal(isPlayerDocument(PLAYER_URL), true);
    assert.equal(isPlayerDocument(`${PLAYER_URL}?market=1`), true);
  });

  it("ignores unrelated subresources", () => {
    assert.equal(isPlayerDocument("https://s5.music.126.net/style.css"), false);
    assert.equal(isPlayerDocument(""), false);
    assert.equal(isPlayerDocument(undefined), false);
  });
});
