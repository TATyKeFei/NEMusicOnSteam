import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampLauncher, readSettings, sanitizeSettings, SETTINGS_KEY, writeSettings } from "./settings.ts";

describe("settings", () => {
  it("drops garbage and keeps defaults", () => {
    const settings = sanitizeSettings({ openOnStart: "yes", launcher: { left: "12" } });
    assert.equal(settings.openOnStart, false);
    assert.equal(settings.keepAliveWhenCollapsed, true);
    assert.deepEqual(settings.launcher, { left: 16, bottom: 16 });
    assert.equal(settings.downloadDirectory, "");
    assert.equal(settings.downloadQuality, 320);
  });

  it("keeps a download directory and quality but rejects unsupported levels", () => {
    assert.equal(sanitizeSettings({ downloadDirectory: "  /home/me/音乐  " }).downloadDirectory, "/home/me/音乐");
    assert.equal(sanitizeSettings({ downloadDirectory: 12 }).downloadDirectory, "");
    for (const quality of [999, 1999, 5999]) assert.equal(sanitizeSettings({ downloadQuality: quality }).downloadQuality, quality);
    for (const quality of ["320", 0, 300, 320.5, NaN, null]) assert.equal(sanitizeSettings({ downloadQuality: quality }).downloadQuality, 320);
  });

  it("round-trips through a storage stub", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    writeSettings(storage, {
      openOnStart: true,
      keepAliveWhenCollapsed: false,
      disableBackgroundThrottling: true,
      launcher: { left: 20, top: 30 },
      downloadDirectory: "~/Music/网易云音乐",
      downloadQuality: 999,
    });
    assert.equal(saved.has(SETTINGS_KEY), true);
    assert.deepEqual(readSettings(storage).launcher, { left: 20, top: 30 });
    assert.equal(readSettings(storage).keepAliveWhenCollapsed, false);
    assert.equal(readSettings(storage).downloadDirectory, "~/Music/网易云音乐");
    assert.equal(readSettings(storage).downloadQuality, 999);
  });

  it("clamps a dragged launcher inside the window", () => {
    assert.deepEqual(clampLauncher({ left: 900, top: -10 }, 800, 600, 72, 32), { left: 728, top: 0 });
  });
});
