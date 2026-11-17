import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOWNLOAD_TASKS_KEY, readDownloadTasks, saveDownloadTasks } from "./task-storage.ts";
import type { DownloadTask } from "./download.ts";

const task = { id: "one", songId: 123, title: "歌曲", artist: "歌手", state: "downloading", path: "", error: "",
  options: { quality: 999, directory: "/music", nameTemplate: "{title}", notificationMode: "none", skipDuplicates: true },
  song: { id: 123, name: "歌曲", artist: "歌手", url: "https://private.example/audio?token=secret" } } as unknown as DownloadTask;
function storage() { let raw = ""; return { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } }; }
describe("download task checkpoints", () => {
  it("restores interrupted jobs with their own options and without old audio URLs", () => {
    const data = storage(); assert.equal(saveDownloadTasks(data, [task]), true);
    assert.doesNotMatch(data.getItem(), /private|token|secret|https/);
    const [restored] = readDownloadTasks(data);
    assert.equal(restored.state, "queued"); assert.equal(restored.options.quality, 999);
    assert.equal(restored.key, "123:999:/music"); assert.equal(restored.song?.id, 123);
  });
  it("rejects malformed and oversized storage and duplicate jobs", () => {
    const data = storage();
    for (const raw of ["bad", "{}", "x".repeat(2_000_001)]) { data.setItem(DOWNLOAD_TASKS_KEY, raw); assert.deepEqual(readDownloadTasks(data), []); }
    saveDownloadTasks(data, [task, task]); assert.equal(readDownloadTasks(data).length, 1);
  });
  it("reports a quota failure without throwing away the live queue", () => {
    assert.equal(saveDownloadTasks({ getItem: () => "", setItem() { throw new Error("quota"); } }, [task]), false);
    assert.equal(task.state, "downloading");
  });
});
