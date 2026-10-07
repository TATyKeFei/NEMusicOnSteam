import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { ChromeModel } from "../widget/chrome.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./player.ts", import.meta.url), "utf8")
    .replace(/^import [\s\S]*? from [^;]+;\n/gm, "")
    .replace(/^export /gm, ""),
);

type Controller = {
  mode: string;
  desktopFullscreen: boolean;
  windowFullscreen: boolean;
  setFullscreen(active: boolean, fillWindow?: boolean): void;
  render(): unknown;
  tick(): void;
  close(): string;
  shutdown(): void;
};

function setup(options: { desktopSupported?: boolean; failToggle?: boolean } = {}) {
  const models: ChromeModel[] = [];
  const toggles: boolean[] = [];
  let onFullscreenRequest: ((active: boolean, fillWindow: boolean) => void) | null = null;
  const client = {
    Window: options.desktopSupported === false ? {} : {
      ToggleFullScreen(active: boolean) {
        if (options.failToggle) throw new Error("toggle failed");
        toggles.push(active);
      },
    },
  };
  class FakeBridge {
    setEnabled() {}
    setExternalPlayback() {}
    async stop() {}
  }
  const ControllerClass = runInNewContext(`${source}; PlayerController`, {
    PlayerChrome: class {
      render(model: ChromeModel) { models.push(model); return null; }
      destroy() {}
    },
    MprisBridge: FakeBridge,
    MpvBridge: FakeBridge,
    RecognitionBridge: FakeBridge,
    QualityBridge: FakeBridge,
    TogetherBridge: FakeBridge,
    DownloadBridge: FakeBridge,
    FullscreenButtonBridge: class extends FakeBridge {
      refresh(callback: (active: boolean, fillWindow: boolean) => void) { onFullscreenRequest = callback; }
    },
    STEAM_PAGE_FALLBACK_CLASSES: {},
    readSettings: () => ({ keepAliveWhenCollapsed: true, disableBackgroundThrottling: false }),
    browserStorage: () => null,
    sharedSteamClient: () => client,
    findMainPopup: () => null,
    releasePlayerSession() {},
    window: { clearInterval() {} },
    console: { warn() {}, error() {} },
  }) as new () => Controller;
  const player = new ControllerClass();
  player.mode = "expanded";
  return {
    player,
    models,
    toggles,
    request(active: boolean, fillWindow: boolean) {
      player.tick();
      assert.ok(onFullscreenRequest);
      onFullscreenRequest(active, fillWindow);
    },
  };
}

describe("player fullscreen modes", () => {
  it("fills the Steam window without calling desktop fullscreen", () => {
    const runtime = setup();
    runtime.request(true, true);
    assert.equal(runtime.player.windowFullscreen, true);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
    assert.deepEqual(runtime.toggles, []);
    runtime.request(false, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
    assert.deepEqual(runtime.toggles, []);
  });

  it("retains desktop fullscreen for ordinary clicks", () => {
    const runtime = setup();
    runtime.request(true, false);
    assert.equal(runtime.player.desktopFullscreen, true);
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
    runtime.request(false, false);
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });

  it("supports window fill without a desktop fullscreen API", () => {
    const runtime = setup({ desktopSupported: false });
    runtime.request(true, true);
    assert.equal(runtime.player.windowFullscreen, true);
    assert.equal(runtime.models.at(-1)?.fullscreen, true);
  });

  it("leaves desktop fullscreen before filling only the window", () => {
    const runtime = setup();
    runtime.request(true, false);
    runtime.request(true, true);
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.player.windowFullscreen, true);
  });

  it("clears window fill when closing the player", () => {
    const runtime = setup();
    runtime.request(true, true);
    runtime.player.close();
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.deepEqual(runtime.toggles, []);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });

  it("restores the Steam window when shutting down in desktop fullscreen", () => {
    const runtime = setup();
    runtime.request(true, false);
    runtime.player.shutdown();
    assert.deepEqual(runtime.toggles, [true, false]);
    assert.equal(runtime.player.desktopFullscreen, false);
  });

  it("does not hide the Steam header if desktop fullscreen fails", () => {
    const runtime = setup({ failToggle: true });
    runtime.request(true, false);
    runtime.player.render();
    assert.equal(runtime.player.desktopFullscreen, false);
    assert.equal(runtime.player.windowFullscreen, false);
    assert.equal(runtime.models.at(-1)?.fullscreen, false);
  });
});
