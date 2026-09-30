import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STEAM_PAGE_FALLBACK_CLASSES, steamPageTransition, steamPageVisible } from "./steam-page.ts";

type Options = {
  classes?: string[];
  width?: number;
  height?: number;
  visibility?: string;
};

function fakeDocument(options: Options = {}): Document {
  const { classes = [], width = 1280, height = 720, visibility = "visible" } = options;
  const element = { getBoundingClientRect: () => ({ width, height }) };
  return {
    defaultView: { getComputedStyle: () => ({ visibility }) },
    getElementsByClassName: (token: string) => (classes.includes(token) ? [element] : []),
  } as unknown as Document;
}

const selectors = { main: "MainBrowserContainer-hash", external: "ExternalBrowserContainer-hash" };

describe("Steam's own web page", () => {
  it("is visible while Steam shows a store, community or news page", () => {
    assert.equal(steamPageVisible(fakeDocument({ classes: ["MainBrowserContainer-hash"] }), selectors), true);
    assert.equal(steamPageVisible(fakeDocument({ classes: ["ExternalBrowserContainer-hash"] }), selectors), true);
  });

  it("is not visible when Steam's browser container is collapsed to nothing", () => {
    assert.equal(
      steamPageVisible(fakeDocument({ classes: ["MainBrowserContainer-hash"], width: 0, height: 0 }), selectors),
      false,
    );
  });

  it("ignores a hidden container and unknown class names", () => {
    assert.equal(
      steamPageVisible(fakeDocument({ classes: ["MainBrowserContainer-hash"], visibility: "hidden" }), selectors),
      false,
    );
    assert.equal(steamPageVisible(fakeDocument({ classes: ["SomethingElse"] }), selectors), false);
  });

  it("survives a missing document or a missing class name", () => {
    assert.equal(steamPageVisible(null, selectors), false);
    assert.equal(steamPageVisible(fakeDocument({ classes: ["MainBrowserContainer-hash"] }), { main: null, external: null }), false);
    assert.equal(steamPageVisible(fakeDocument(), STEAM_PAGE_FALLBACK_CLASSES), false);
  });
});

describe("yielding to Steam's own page", () => {
  it("steps aside when Steam opens a page over the expanded player", () => {
    assert.equal(steamPageTransition(false, true, "expanded", false), "yield");
  });

  it("leaves a collapsed or closed player alone", () => {
    assert.equal(steamPageTransition(false, true, "collapsed", false), "none");
    assert.equal(steamPageTransition(false, true, "closed", false), "none");
  });

  it("comes back only after stepping aside itself", () => {
    assert.equal(steamPageTransition(true, false, "collapsed", true), "restore");
    assert.equal(steamPageTransition(true, false, "collapsed", false), "none");
  });

  it("does nothing on the first look or while the state is unchanged", () => {
    assert.equal(steamPageTransition(null, true, "expanded", false), "none");
    assert.equal(steamPageTransition(true, true, "expanded", false), "none");
    assert.equal(steamPageTransition(false, false, "expanded", false), "none");
  });
});
