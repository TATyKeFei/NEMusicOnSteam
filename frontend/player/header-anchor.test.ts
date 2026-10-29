import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { HEADER_ANCHOR_SCRIPT } from "./header-anchor.ts";

describe("shared header anchor", () => {
  function input(header: boolean, hint: string, left = 0, visible = true) {
    return { hint, visible, closest: (selector: string) => header && selector.includes("#page_pc_main_nav") ? {} : null,
      getAttribute: (name: string) => name === "placeholder" ? hint : "", getBoundingClientRect: () => ({ width: 200, height: 30, bottom: 50, left }) };
  }
  const candidates = (inputs: unknown[]) => runInNewContext(`(() => { ${HEADER_ANCHOR_SCRIPT}; return headerSearchInputs(); })()`, {
    document: { querySelectorAll: () => inputs }, getComputedStyle: (node: { visible: boolean }) => ({ display: node.visible ? "block" : "none" }),
  });
  it("rejects a playlist search even at the top of the viewport", () => {
    const playlist = input(false, "搜索我喜欢的音乐"), global = input(true, "推荐歌曲", 300);
    assert.equal(candidates([playlist]).length, 0); assert.equal(candidates([playlist, global])[0], global);
  });
  it("ignores hidden header inputs and ranks the real search within the header", () => {
    const hidden = input(true, "搜索", 0, false), unrelated = input(true, "", 0), search = input(true, "搜索音乐", 300);
    const result = candidates([hidden, unrelated, search]); assert.equal(result.length, 2); assert.equal(result[0], search);
  });
});
