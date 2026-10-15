import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { DownloadSong } from "./download-player.ts";
import type { NotificationMode } from "../settings.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./download.ts", import.meta.url), "utf8")
    .replace(/^import [\s\S]*? from [^;]+;\n/gm, "")
    .replace(/^export /gm, ""),
);

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const songs: DownloadSong[] = [
  { id: 1, name: "第一首", artist: "歌手" },
  { id: 2, name: "第二首", artist: "歌手" },
  { id: 3, name: "第三首", artist: "歌手" },
];

type TestBridge = {
  setEnabled(enabled: boolean): void;
  tickMenu(): Promise<void>;
  download(song: DownloadSong): Promise<void>;
  snapshot(): { busy: boolean };
};

function setup(options: { notificationMode?: NotificationMode; downloadError?: string } = {}) {
  const pending: DownloadSong[] = [];
  const downloaded: number[] = [];
  const notificationModes: NotificationMode[] = [];
  const notifications: { title: string; body: string }[] = [];
  const waits: (() => void)[] = [];
  const downloadError = options.downloadError ?? "";
  let currentSong: DownloadSong | null = null;
  const Bridge = runInNewContext(`${source}; DownloadBridge`, {
    window: {
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: (callback: () => void) => { waits.push(callback); return 1; },
    },
    ffi: () => async () => "http://localhost|test-token",
    MENU_POLL_SCRIPT: "poll",
    MENU_TICK_SCRIPT: "install",
    menuToastScript: () => "toast",
    steamToast: (title: string, body: string) => { notifications.push({ title, body }); },
    songFileName: () => "歌曲",
    downloadScript: (_quality: number, song: DownloadSong) => {
      currentSong = song;
      return "download";
    },
    evaluateInPlayer: async (expression: string) => {
      if (expression === "toast") return true;
      if (expression === "download") {
        return { url: `https://audio.example/${currentSong!.id}.mp3`, name: currentSong!.name, artist: currentSong!.artist, source: "api" };
      }
      return { installed: true, menus: 1, songs: 1, pending: pending.splice(0) };
    },
    fetch: async (_url: string, options: { body?: string }) => {
      if (options.body) {
        const payload = JSON.parse(options.body);
        downloaded.push(Number(payload.url.match(/\/(\d+)\.mp3$/)[1]));
        notificationModes.push(payload.notify);
      }
      return {
        ok: true,
        status: options.body ? 202 : 200,
        json: async () => ({ active: false, error: downloadError, path: "/music/song.mp3" }),
      };
    },
  }) as new (options: unknown) => TestBridge;
  const bridge = new Bridge(() => ({ quality: 320, directory: "", nameTemplate: "{title}", notificationMode: options.notificationMode ?? "none" }));
  return { bridge, pending, downloaded, waits, notificationModes, notifications };
}

async function finishDownloads(player: ReturnType<typeof setup>) {
  await flush();
  for (let index = 0; index < songs.length + 1 && player.waits.length; index++) {
    player.waits.shift()!();
    await flush();
  }
}

describe("download menu queue", () => {
  it("downloads every request from one menu poll in order", async () => {
    const player = setup();
    player.pending.push(...songs);
    player.bridge.setEnabled(true);
    await finishDownloads(player);
    assert.deepEqual(player.downloaded, [1, 2, 3]);
    assert.equal(player.pending.length, 0);
    assert.equal(player.bridge.snapshot().busy, false);
  });

  it("keeps all menu requests behind an active download", async () => {
    const player = setup();
    player.bridge.setEnabled(true);
    await flush();
    void player.bridge.download(songs[0]);
    await flush();
    player.pending.push(...songs.slice(1));
    void player.bridge.tickMenu();
    await finishDownloads(player);
    assert.deepEqual(player.downloaded, [1, 2, 3]);
    assert.equal(player.bridge.snapshot().busy, false);
  });

  it("clears queued menu requests when disabled", async () => {
    const player = setup();
    player.pending.push(...songs);
    player.bridge.setEnabled(true);
    await flush();
    assert.deepEqual(player.downloaded, [1]);
    player.bridge.setEnabled(false);
    await finishDownloads(player);
    assert.deepEqual(player.downloaded, [1]);
    assert.equal(player.bridge.snapshot().busy, false);
  });
});

describe("shared notification mode", () => {
  for (const notificationMode of ["system", "steam", "none"] as const) {
    it(`uses ${notificationMode} for completed downloads`, async () => {
      const player = setup({ notificationMode });
      player.pending.push(songs[0]);
      player.bridge.setEnabled(true);
      await finishDownloads(player);
      assert.deepEqual(player.notificationModes, [notificationMode]);
      assert.deepEqual(player.notifications, notificationMode === "steam" ? [{ title: "下载完成", body: "/music/song.mp3" }] : []);
    });

    it(`uses ${notificationMode} for failed downloads`, async () => {
      const player = setup({ notificationMode, downloadError: "下载错误" });
      player.pending.push(songs[0]);
      player.bridge.setEnabled(true);
      await finishDownloads(player);
      assert.deepEqual(player.notificationModes, [notificationMode]);
      assert.deepEqual(player.notifications, notificationMode === "steam" ? [{ title: "下载失败", body: "下载错误" }] : []);
    });
  }
});
