import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DownloadSong } from "./download-player.ts";
import type { NotificationMode } from "../settings.ts";
import { HelperClient } from "../runtime/helper-client.ts";
import { DownloadBridge } from "./download.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const songs: DownloadSong[] = [
  { id: 1, name: "第一首", artist: "歌手" },
  { id: 2, name: "第二首", artist: "歌手" },
  { id: 3, name: "第三首", artist: "歌手" },
];

function setup(options: { notificationMode?: NotificationMode; downloadError?: string } = {}) {
  const pending: DownloadSong[] = [];
  const downloaded: number[] = [];
  const notificationModes: NotificationMode[] = [];
  const notifications: { title: string; body: string }[] = [];
  const waits: (() => void)[] = [];
  const downloadError = options.downloadError ?? "";
  const requests: string[] = [];
  const helper = new HelperClient(async () => "http://localhost:1|old-token", async () => "http://localhost:2|new-token",
    async (url, init) => {
      requests.push(String(url));
      if (init?.body) {
        const payload = JSON.parse(String(init.body));
        downloaded.push(Number(payload.url.match(/\/(\d+)\.mp3$/)[1]));
        notificationModes.push(payload.notify);
      }
      return new Response(JSON.stringify({ active: false, error: downloadError, path: "/music/song.mp3" }), { status: init?.body ? 202 : 200 });
    });
  let poll = () => {};
  const bridge = new DownloadBridge(
    () => ({ quality: 320, directory: "", nameTemplate: "{title}", notificationMode: options.notificationMode ?? "none" }),
    {
      helper,
      evaluate: async () => ({ installed: true, menus: 1, songs: 1, pending: pending.splice(0) }),
      notify: (title, body) => { notifications.push({ title, body }); },
      timers: {
        setInterval: callback => { poll = callback as () => void; return 1; },
        clearInterval() {},
        setTimeout: callback => { waits.push(callback as () => void); return 1; },
      },
    },
    async (_quality, song) => ({ url: `https://audio.example/${song!.id}.mp3`, name: song!.name, artist: song!.artist, source: "api" }),
  );
  return { bridge, pending, downloaded, waits, notificationModes, notifications, helper, requests, poll: () => poll() };
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
    player.poll();
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

describe("download helper restart", () => {
  it("uses the shared replacement endpoint for subsequent downloads", async () => {
    const player = setup();
    player.pending.push(songs[0]);
    player.bridge.setEnabled(true);
    await finishDownloads(player);
    await player.helper.connect(true);
    const previous = player.requests.length;
    player.pending.push(songs[1]);
    player.poll();
    await finishDownloads(player);
    assert.deepEqual(player.downloaded, [1, 2]);
    assert.ok(player.requests.slice(previous).every(url => url.startsWith("http://localhost:2/")));
  });
});
