import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(readFileSync(new URL("./diagnostics.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
function setup(environment = "mpv=ok\npython3=missing\nunknown=private\nMillennium=2.40.0\ncookie=secret") {
  return runInNewContext(`${source}; ({ redactDiagnostic, collectDiagnostics })`, {
    ffi: () => async () => environment, navigator: { platform: "Linux" }, PLAYER_READY_SCRIPT: "ready", tryEvaluateInPlayer: async () => true,
  }) as { redactDiagnostic(value: string): string; collectDiagnostics(snapshot: any): Promise<string> };
}
describe("privacy filtered diagnostics", () => {
  it("removes endpoints, paths with spaces and credential fields", () => {
    const api = setup();
    for (const value of ["失败 https://host.example/audio?token=secret", "失败 /home/Real Name/music file.flac", "失败 C:\\Users\\Real Name\\music.mp3", "Authorization: Bearer secret", "uid=123456", "cookie: sid=secret; other=private"]) {
      const result = api.redactDiagnostic(value); assert.doesNotMatch(result, /host\.example|Real Name|secret|123456|private/);
    }
    assert.equal(api.redactDiagnostic("mpv 已连接"), "mpv 已连接");
  });
  it("whitelists dependency output and omits raw settings and metadata", async () => {
    const api = setup(); const report = await api.collectDiagnostics({ settings: { playbackBackend: "mpv", mpd: { password: "private" } }, status: "已加载", mprisStatus: "已连接", mpvStatus: "失败 https://host.example/private", mpdStatus: "关闭", unblockStatus: "关闭", recognitionStatus: "就绪", preloadStatus: "已缓冲", title: "private", hasView: true });
    assert.match(report, /mpv：可用/); assert.match(report, /python3：未检测到/); assert.match(report, /网页连接：正常/);
    assert.doesNotMatch(report, /private|secret|cookie|host\.example|unknown/);
  });
});
