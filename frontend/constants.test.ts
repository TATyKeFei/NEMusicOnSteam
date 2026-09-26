import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlayerDocument, mprisCommand, MPRIS_PLAYER_NAME, PLAYER_URL } from "./constants.ts";

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

describe("desktop shortcut command", () => {
  it("always pins the player so a browser cannot steal the key", () => {
    for (const action of ["play-pause", "next", "previous"]) {
      assert.equal(mprisCommand(action), `playerctl -p ${MPRIS_PLAYER_NAME} ${action}`);
      assert.match(mprisCommand(action), /-p NEMusicOnSteam /);
    }
  });

  it("matches the name the helper registers on the bus", () => {
    assert.equal(MPRIS_PLAYER_NAME, "NEMusicOnSteam");
  });
});
