import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrackState } from "../mpris/mpris.ts";
import type { Command } from "../mpris/mpris-player.ts";
import type { SongLyrics } from "./lyrics.ts";
import { NowPlayingSession, type NowPlayingSource, type NowPlayingState } from "./session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const lyrics = (text: string): SongLyrics => ({ lines: [{ at: 0, text, translation: "" }], text, instrumental: false });

function fixture() {
  let track = { active: true, trackId: "123", position: 10, playbackStatus: "Playing" } as TrackState;
  const changes: NowPlayingState[] = [], commands: { command: Command; trackId?: string }[] = [];
  const source: NowPlayingSource = {
    readPlaybackState: async () => track,
    readSongLyrics: async () => lyrics(track.trackId),
    controlPlayback: async (command, trackId) => { commands.push({ command, trackId }); return true; },
    open: () => "ok",
  };
  const session = new NowPlayingSession(source, state => changes.push(state));
  return { source, session, changes, commands, state: () => changes.at(-1)!, setTrack: (id: string, position = 0) => {
    track = { ...track, trackId: id, position };
  } };
}

describe("song panel session", () => {
  it("keeps progress and playback controls responsive while lyrics load", async () => {
    const panel = fixture(), slow = deferred<SongLyrics>();
    panel.source.readSongLyrics = () => slow.promise;
    panel.session.start(); await flush();
    assert.equal(panel.state().lyricsLoading, true);
    panel.setTrack("123", 11); await panel.session.refresh();
    assert.equal(panel.state().track?.position, 11);
    await panel.session.command({ action: "pause" });
    assert.equal(panel.commands[0].command.action, "pause");
    slow.resolve(lyrics("Hello")); await flush();
    assert.equal(panel.state().lyrics?.text, "Hello");
    panel.session.stop();
  });

  it("ignores old lyrics arriving after the next song", async () => {
    const panel = fixture(), old = deferred<SongLyrics>();
    panel.source.readSongLyrics = async id => id === "123" ? old.promise : lyrics("New song");
    panel.session.start(); await flush();
    panel.setTrack("456"); await panel.session.refresh(); await flush();
    old.resolve(lyrics("Old song")); await flush();
    assert.equal(panel.state().lyrics?.text, "New song");
    panel.session.stop();
  });

  it("does not update a closed panel and refreshes when reopened during an old read", async () => {
    const panel = fixture(), old = deferred<TrackState | null>();
    panel.source.readPlaybackState = () => old.promise;
    panel.session.start(); panel.session.stop();
    old.resolve(null); await flush();
    assert.equal(panel.changes.length, 0);
    const next = deferred<TrackState | null>();
    panel.source.readPlaybackState = () => next.promise;
    panel.session.start(); panel.session.stop();
    panel.source.readPlaybackState = async () => ({ active: true, trackId: "456" } as TrackState);
    panel.session.start(); next.resolve(null); await flush();
    assert.equal(panel.state().track?.trackId, "456");
    panel.session.stop();
  });

  it("serializes controls and rejects a seek belonging to another song", async () => {
    const panel = fixture(), pending = deferred<boolean>();
    panel.session.start(); await flush();
    await panel.session.command({ action: "setposition", value: 30_000_000 }, "old");
    assert.equal(panel.commands.length, 0);
    panel.source.controlPlayback = () => pending.promise;
    const command = panel.session.command({ action: "next" });
    assert.equal(panel.state().pending, true);
    await panel.session.command({ action: "next" });
    pending.resolve(false); await command;
    assert.equal(panel.state().pending, false);
    assert.match(panel.state().error, /未响应/);
    panel.session.stop();
  });

  it("recovers read errors and loads lyrics once per song", async () => {
    const panel = fixture();
    panel.source.readPlaybackState = async () => { throw new Error("offline"); };
    panel.session.start(); await flush();
    assert.match(panel.state().error, /读取/);
    let loads = 0;
    panel.source.readPlaybackState = async () => ({ active: true, trackId: "123" } as TrackState);
    panel.source.readSongLyrics = async () => { loads++; throw new Error("offline"); };
    await panel.session.refresh(); await flush();
    assert.equal(panel.state().error, "");
    assert.match(panel.state().lyricsError, /歌词/);
    await panel.session.refresh(); assert.equal(loads, 1);
    panel.session.stop();
  });
});
