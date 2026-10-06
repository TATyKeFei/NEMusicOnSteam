import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { uiScaleScript } from "./ui-scale.ts";

class Element {
  id = "";
  textContent = "";
}

describe("网易云界面缩放", () => {
  it("复用样式节点并更新缩放值", () => {
    const head = {
      children: [] as Element[],
      append(element: Element) { this.children.push(element); },
    };
    const context = {
      document: {
        head,
        getElementById: (id: string) => head.children.find(element => element.id === id) ?? null,
        createElement: () => new Element(),
      },
    };
    assert.equal(runInNewContext(uiScaleScript(1.25), context), 1.25);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].textContent, "html { zoom: 1.25; }");
    assert.equal(runInNewContext(uiScaleScript(0.9), context), 0.9);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].textContent, "html { zoom: 0.9; }");
  });
});
