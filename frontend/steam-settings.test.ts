import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const luaSource = readFileSync(new URL("../backend/main.lua", import.meta.url), "utf8");
const patch = luaSource.match(/find = \[\[(return Ga.*?)\]\],[\s\S]*?replace = \[=\[([\s\S]*?)\]=\]/);
const settingsList = `function settingsPages(){return a.useMemo(()=>{const Ga=[];for(let oo=0;oo<Kr.length;oo++){const qa=Kr[oo];if(qa===l.I0)oo!==0&&oo!==Kr.length-1&&Kr[oo+1]!==l.I0&&Ga.push(l.I0);else{const Or=Ua[qa];Or&&Or&&Or.visible&&Ga.push(Or)}}return Ga},[Kr,Ua])}`;

describe("Steam settings page integration", () => {
  it("adds a native settings route and renders the plugin component without replacing Steam's pages", () => {
    assert.ok(patch);
    const expression = settingsList.replace(new RegExp(patch[1]), () => patch[2].replaceAll("#{{self}}", "testPlugin"));
    assert.notEqual(expression, settingsList);
    const content = { type: "NetEaseSettings" };
    const account = { visible: true, route: "/settings/account" };
    const pages = runInNewContext(`${expression}; settingsPages()`, {
      a: { useMemo: (factory: () => unknown) => factory() },
      e: { jsx: (component: unknown) => typeof component === "function" ? component() : { type: component } },
      d: { Music: "MusicIcon" },
      r: { BV: { Settings: { Music: () => "/settings/music" } } },
      testPlugin: { renderSettings: () => content },
      Kr: ["Account", "Hidden"],
      Ua: { Account: account, Hidden: { visible: false } },
      l: { I0: "separator" },
    });
    assert.equal(pages.length, 2);
    assert.equal(pages[0], account);
    assert.equal(pages[1].title, "网易云音乐");
    assert.equal(pages[1].route, "/settings/nemusic");
    assert.equal(pages[1].content, content);
  });
});
