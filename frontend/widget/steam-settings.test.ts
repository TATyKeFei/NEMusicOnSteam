import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { SteamWindow } from "../player/steam.ts";
import { SETTINGS_ICON } from "./settings-icon.ts";

const luaSource = readFileSync(new URL("../../backend/main.lua", import.meta.url), "utf8");
const patch = luaSource.match(/find = \[\[(return Ga.*?)\]\],[\s\S]*?replace = \[=\[([\s\S]*?)\]=\]/);
const settingsList = `function settingsPages(){return a.useMemo(()=>{const Ga=[];for(let oo=0;oo<Kr.length;oo++){const qa=Kr[oo];if(qa===l.I0)oo!==0&&oo!==Kr.length-1&&Kr[oo+1]!==l.I0&&Ga.push(l.I0);else{const Or=Ua[qa];Or&&Or&&Or.visible&&Ga.push(Or)}}return Ga},[Kr,Ua])}`;

const settingsSource = stripTypeScriptTypes(
  readFileSync(new URL("./steam-settings.ts", import.meta.url), "utf8")
    .replace(/^import [\s\S]*? from [^;]+;\n/gm, "")
    .replace(/^export /gm, ""),
);

type TestSettingsEntry = {
  start: () => void;
  stop: () => void;
  open: (win: SteamWindow) => void;
  entryStatus: () => string;
  mounted: Map<Document, { dialog: HTMLElement; button: HTMLButtonElement; dispose: () => void }>;
};

function settingsFixture(shared = false) {
  const urls: string[] = [];
  let selections = 0;
  let available = false;
  let poll: (() => void) | null = null;
  const button = {
    isConnected: true,
    textContent: "网易云音乐",
    click: () => { selections++; },
  } as unknown as HTMLButtonElement;
  const list = {
    textContent: "帐户　网易云音乐",
    querySelectorAll: () => [button],
  };
  const column = {};
  const dialog = {
    isConnected: true,
    querySelector: (selector: string) => selector.includes("PagedSettingsDialog_PageList") ? list : column,
  } as unknown as HTMLElement;
  const doc = {
    defaultView: { closed: false },
    querySelector: () => dialog,
  } as unknown as Document;
  const urlApi = {
    ExecuteSteamURL(url: string) {
      assert.equal(this, urlApi);
      urls.push(url);
    },
  };
  const client = { URL: urlApi };
  const win = { document: doc, closed: false, SteamClient: shared ? undefined : client } as SteamWindow;
  const SettingsEntry = runInNewContext(`${settingsSource}; SteamSettingsEntry`, {
    findModule: () => null,
    steamGlobals: () => ({ g_PopupManager: { GetPopups: () => available ? [{ window: win }] : [] } }),
    sharedSteamClient: () => client,
    window: { setInterval: (callback: () => void) => { poll = callback; return 1; }, clearInterval: () => {} },
    console: { warn: () => {} },
  }) as new (content: () => null) => TestSettingsEntry;
  const entry = new SettingsEntry(() => null);
  return {
    entry, win, doc, dialog, button, urls,
    show: () => { available = true; },
    poll: () => poll?.(),
    selections: () => selections,
  };
}

describe("Steam settings page integration", () => {
  it("opens Steam settings and selects the native music page once it appears", () => {
    const settings = settingsFixture();
    settings.entry.start();
    settings.entry.open(settings.win);
    assert.deepEqual(settings.urls, ["steam://open/settings"]);
    assert.equal(settings.selections(), 0);
    settings.show();
    settings.poll();
    assert.equal(settings.selections(), 1);
    assert.equal(settings.entry.entryStatus(), "native");
    settings.poll();
    assert.equal(settings.selections(), 1);
    settings.entry.open(settings.win);
    assert.equal(settings.selections(), 2);
  });

  it("selects an already injected settings page and uses the shared Steam client", () => {
    const settings = settingsFixture(true);
    settings.entry.mounted.set(settings.doc, { dialog: settings.dialog, button: settings.button, dispose: () => {} });
    settings.show();
    settings.entry.open(settings.win);
    assert.deepEqual(settings.urls, ["steam://open/settings"]);
    assert.equal(settings.selections(), 1);
  });

  it("cancels a pending page selection when the plugin stops", () => {
    const settings = settingsFixture();
    settings.entry.start();
    settings.entry.open(settings.win);
    settings.entry.stop();
    settings.show();
    settings.entry.start();
    assert.equal(settings.selections(), 0);
  });

  it("在后端卸载时终止脱离 Steam 的辅助进程", () => {
    assert.ok(luaSource.includes('(interpreter or "python3")'));
    assert.ok(luaSource.includes("kill -TERM -- -"));
    assert.ok(luaSource.includes("stop_helper(mpris_dir)"));
    assert.ok(luaSource.includes("stop_helper(mpv_dir)"));
    assert.ok(luaSource.includes("unblock_stop()"));
    assert.doesNotMatch(luaSource.match(/local function on_unload\(\)[\s\S]*?\nend\n\nreturn/)?.[0] ?? "", /call_frontend_method/);
  });

  it("adds a native settings route and renders the plugin component without replacing Steam's pages", () => {
    assert.ok(patch);
    const expression = settingsList.replace(new RegExp(patch[1]), () => patch[2].replaceAll("#{{self}}", "testPlugin"));
    assert.notEqual(expression, settingsList);
    const content = { type: "NetEaseSettings" };
    const icon = { type: "NetEaseLogo" };
    const account = { visible: true, route: "/settings/account" };
    const pages = runInNewContext(`${expression}; settingsPages()`, {
      a: { useMemo: (factory: () => unknown) => factory() },
      e: { jsx: (component: unknown) => typeof component === "function" ? component() : { type: component } },
      d: { Music: "MusicIcon" },
      r: { BV: { Settings: { Music: () => "/settings/music" } } },
      testPlugin: { renderSettings: () => content, renderSettingsIcon: () => icon },
      Kr: ["Account", "Hidden"],
      Ua: { Account: account, Hidden: { visible: false } },
      l: { I0: "separator" },
    });
    assert.equal(pages.length, 2);
    assert.equal(pages[0], account);
    assert.equal(pages[1].title, "网易云音乐");
    assert.equal(pages[1].route, "/settings/nemusic");
    assert.equal(pages[1].content, content);
    assert.equal(pages[1].icon, icon);
  });

  it("uses the logo.svg artwork for the settings icon", () => {
    const asset = readFileSync(new URL("../../assets/icon/logo.svg", import.meta.url), "utf8");
    const paths = (svg: string) => [...svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map(match => match[1]);
    assert.deepEqual(paths(SETTINGS_ICON), paths(asset));
  });
});
