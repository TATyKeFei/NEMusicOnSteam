import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { headerHeightFromNav, isHtmlElement, isSupernavItemStyle, navLabel, scoreNavRow, sharedClasses } from "./nav.ts";

describe("supernav row", () => {
  it("accepts HTML elements from another window realm", () => {
    const foreignElement = runInNewContext('({ namespaceURI: "http://www.w3.org/1999/xhtml" })') as Element;
    assert.equal(isHtmlElement(foreignElement), true);
    assert.equal(isHtmlElement({ namespaceURI: "http://www.w3.org/2000/svg" } as Element), false);
  });

  it("prefers the library row over a shorter row above it", () => {
    const menu = scoreNavRow({ top: 4, height: 32, width: 1280, flexRow: true, labels: ["Steam", "视图"] });
    const library = scoreNavRow({ top: 36, height: 32, width: 1280, flexRow: true, labels: ["库", "社区", "个人"] });
    assert.ok(library > menu);
  });

  it("prefers the 18px supernav row over the busier window menu", () => {
    const menu = scoreNavRow({
      top: 4,
      height: 32,
      width: 900,
      flexRow: true,
      labels: ["Steam", "视图", "好友", "游戏", "帮助"],
      styledItems: 0,
    });
    const library = scoreNavRow({
      top: 36,
      height: 30,
      width: 1280,
      flexRow: true,
      labels: ["库", "社区"],
      styledItems: 4,
    });
    assert.equal(menu, 0);
    assert.ok(library > menu);
    assert.ok(library >= 1000);
  });

  it("rejects a clipped menu row so the link is not inserted where it cannot be seen", () => {
    assert.equal(
      scoreNavRow({
        top: 4,
        height: 32,
        width: 900,
        flexRow: true,
        labels: ["Steam", "视图", "好友", "游戏", "帮助"],
        overflowHidden: true,
      }),
      0,
    );
  });

  it("recognizes the supernav item style", () => {
    assert.equal(isSupernavItemStyle(18, "uppercase", "pointer"), true);
    assert.equal(isSupernavItemStyle(13, "uppercase", "pointer"), false);
    assert.equal(isSupernavItemStyle(18, "none", "pointer"), false);
  });

  it("rejects columns, tiny rows, and single labels", () => {
    assert.equal(scoreNavRow({ top: 36, height: 32, width: 1280, flexRow: false, labels: ["库", "社区"] }), 0);
    assert.equal(scoreNavRow({ top: 36, height: 80, width: 1280, flexRow: true, labels: ["库", "社区"] }), 0);
    assert.equal(scoreNavRow({ top: 36, height: 32, width: 1280, flexRow: true, labels: ["库"] }), 0);
  });

  it("keeps short nav labels and drops long profile names", () => {
    assert.equal(navLabel("  社区 "), "社区");
    assert.equal(navLabel("一个长到不像顶部栏目的个人资料显示名称"), null);
  });

  it("uses the nav row bottom as the header when it is plausible", () => {
    assert.equal(headerHeightFromNav(68.4, 48), 68);
    assert.equal(headerHeightFromNav(8, 48), 48);
    assert.equal(headerHeightFromNav(null, 48), 48);
  });

  it("keeps classes shared by every nav item", () => {
    assert.equal(sharedClasses(["nav item selected", "nav item", "nav item"]), "nav item");
  });
});
