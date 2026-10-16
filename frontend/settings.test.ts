import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSettings, readSettings, sanitizeSettings, SETTINGS_KEY, uiScaleOr, writeSettings } from "./settings.ts";

describe("settings", () => {
  it("keeps mpv transitions opt-in and bounds their duration", () => {
    assert.equal(sanitizeSettings({}).mpvTransitionMode, "off");
    assert.equal(sanitizeSettings({ mpvTransition: true }).mpvTransitionMode, "normal");
    assert.equal(sanitizeSettings({ mpvTransitionMode: "smart" }).mpvTransitionMode, "smart");
    assert.equal(sanitizeSettings({ mpvTransitionMode: "banana" }).mpvTransitionMode, "off");
    assert.equal(sanitizeSettings({ mpvTransitionSeconds: 99 }).mpvTransitionSeconds, 12);
    assert.equal(sanitizeSettings({ mpvTransitionSeconds: -2 }).mpvTransitionSeconds, 1);
    assert.equal(sanitizeSettings({ mpvTransitionSeconds: NaN }).mpvTransitionSeconds, 6);
  });
  it("drops garbage and keeps defaults", () => {
    const settings = sanitizeSettings({ openOnStart: "yes", launcher: { left: "12" } });
    assert.equal(settings.openOnStart, false);
    assert.equal(settings.playbackBackend, "web");
    assert.equal(settings.uiScale, 1);
    assert.equal(settings.keepAliveWhenCollapsed, true);
    assert.equal("launcher" in settings, false);
    assert.equal(settings.downloadDirectory, "");
    assert.equal(settings.downloadQuality, 320);
  });

  it("keeps UI scale within the supported range", () => {
    assert.equal(uiScaleOr(1.25, 1), 1.25);
    assert.equal(uiScaleOr(9, 1), 1.5);
    assert.equal(uiScaleOr(0.1, 1), 0.8);
    assert.equal(uiScaleOr("125%", 1), 1);
  });

  it("supports MPD TCP, password and Unix socket settings without sharing mutable defaults", () => {
    const settings = sanitizeSettings({ playbackBackend: "mpd", mpd: { host: " music.local ", port: 6601, password: " secret ", socket: " ~/mpd/socket " } });
    assert.equal(settings.playbackBackend, "mpd");
    assert.deepEqual(settings.mpd, { host: "music.local", port: 6601, password: " secret ", socket: "~/mpd/socket" });
    settings.mpd.host = "changed";
    assert.equal(sanitizeSettings({}).mpd.host, "127.0.0.1");
    for (const port of [-1, 0, 65536, 6600.1, "6600", NaN]) {
      assert.equal(sanitizeSettings({ mpd: { port } }).mpd.port, 6600);
    }
    assert.equal(sanitizeSettings({ mpd: { password: "a\nclear\x00" } }).mpd.password, "aclear");
  });

  it("defaults to disabled and filters duplicate or unsupported unblock sources in order", () => {
    assert.equal(sanitizeSettings({}).unblockEnabled, false);
    assert.equal(sanitizeSettings({ unblockEnabled: "true" }).unblockEnabled, false);
    assert.equal(sanitizeSettings({ unblockEnabled: true }).unblockEnabled, true);
    assert.deepEqual(sanitizeSettings({ unblockSources: ["bilivideo", "qq", "kuwo", "bilivideo", null] }).unblockSources, ["bilivideo", "kuwo"]);
    for (const unblockSources of [[], null, "kuwo", ["unsupported"]]) {
      assert.deepEqual(sanitizeSettings({ unblockSources }).unblockSources, ["kuwo", "kugou", "bilivideo"]);
    }
    const settings = sanitizeSettings({});
    settings.unblockSources.push("bodian");
    assert.deepEqual(sanitizeSettings({}).unblockSources, ["kuwo", "kugou", "bilivideo"]);
  });

  it("keeps a download directory and quality but rejects unsupported levels", () => {
    assert.equal(sanitizeSettings({ downloadDirectory: "  /home/me/音乐  " }).downloadDirectory, "/home/me/音乐");
    assert.equal(sanitizeSettings({ downloadDirectory: 12 }).downloadDirectory, "");
    for (const quality of [999, 1999, 5999]) assert.equal(sanitizeSettings({ downloadQuality: quality }).downloadQuality, quality);
    for (const quality of ["320", 0, 300, 320.5, NaN, null]) assert.equal(sanitizeSettings({ downloadQuality: quality }).downloadQuality, 320);
  });

  it("merges separate notification preferences using the existing track notification mode", () => {
    for (const notificationMode of ["system", "steam", "none"]) {
      const settings = sanitizeSettings({ notificationMode, downloadNotificationMode: notificationMode === "none" ? "steam" : "none" });
      assert.equal(settings.notificationMode, notificationMode);
      assert.equal("downloadNotificationMode" in settings, false);
    }
  });

  it("falls back to a valid legacy download notification preference or the default", () => {
    assert.equal(sanitizeSettings({ downloadNotificationMode: "none" }).notificationMode, "none");
    assert.equal(sanitizeSettings({ notificationMode: "invalid", downloadNotificationMode: "steam" }).notificationMode, "steam");
    assert.equal(sanitizeSettings({ notificationMode: "invalid", downloadNotificationMode: "invalid" }).notificationMode, "system");
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
      ...defaultSettings,
      openOnStart: true,
      playbackBackend: "mpv",
      keepAliveWhenCollapsed: false,
      disableBackgroundThrottling: true,
      downloadDirectory: "~/Music/网易云音乐",
      downloadQuality: 999,
    });
    assert.equal(saved.has(SETTINGS_KEY), true);
    assert.equal("launcher" in readSettings(storage), false);
    assert.equal(readSettings(storage).keepAliveWhenCollapsed, false);
    assert.equal(readSettings(storage).playbackBackend, "mpv");
    assert.equal(readSettings(storage).downloadDirectory, "~/Music/网易云音乐");
    assert.equal(readSettings(storage).downloadQuality, 999);
  });

});
