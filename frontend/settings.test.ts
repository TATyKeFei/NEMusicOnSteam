import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampLauncher, readSettings, sanitizeSettings, SETTINGS_KEY, writeSettings } from "./settings.ts";

describe("settings", () => {
  it("drops garbage and keeps defaults", () => {
    const settings = sanitizeSettings({ openOnStart: "yes", launcher: { left: "12" } });
    assert.equal(settings.openOnStart, false);
    assert.equal(settings.keepAliveWhenCollapsed, true);
    assert.deepEqual(settings.launcher, { left: 16, bottom: 16 });
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
    });
    assert.equal(saved.has(SETTINGS_KEY), true);
    assert.deepEqual(readSettings(storage).launcher, { left: 20, top: 30 });
    assert.equal(readSettings(storage).keepAliveWhenCollapsed, false);
  });

  it("clamps a dragged launcher inside the window", () => {
    assert.deepEqual(clampLauncher({ left: 900, top: -10 }, 800, 600, 72, 32), { left: 728, top: 0 });
  });
});
