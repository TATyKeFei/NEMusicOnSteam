import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import type { TogetherState } from "./together-player.ts";
import type { TogetherSnapshot } from "./together.ts";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./together.ts", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replace(/^export /gm, ""),
);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type Bridge = {
  timer: number;
  state: TogetherState;
  identityApplied: boolean;
  started: boolean;
  lastInRoom: boolean;
  serverInRoom: boolean;
  serverRoomId: string;
  pending: string | null;
  snapshot(): TogetherSnapshot;
  leave(): void;
  tick(): Promise<void>;
  pullRemoteCommands(): void;
};

function setup(options: { firstState?: Promise<unknown>; remote?: Record<string, unknown>; leaveResult?: { ok: boolean; error?: string } } = {}) {
  const evaluations: string[] = [];
  let stateReads = 0;
  let page: TogetherState = {
    supported: true, loggedIn: true, accountId: "10001", status: "together", inRoom: true, isHost: false,
    roomId: "123456", chatRoomId: "chat-9", creatorId: "20002", hostNickname: "房主", hostAvatarUrl: "avatar",
    members: [{ userId: "20002", nickname: "房主", avatarUrl: "avatar" }],
    currentSongId: "999", songIds: ["999"], playing: true, positionMs: 10000, localOnly: false,
    probe: [], action: "", diagnostic: "",
  };
  const Class = runInNewContext(`${source}; TogetherBridge`, {
    IDENTITY_IDLE: {},
    PLAYER_TARGET_MISSING: "missing",
    TOGETHER_STATE_SCRIPT: "state",
    TOGETHER_LEAVE_SCRIPT: "leave",
    TOGETHER_CLEAR_SCRIPT: "clear",
    TOGETHER_RESTORE_SCRIPT: "restore",
    TOGETHER_SYNC_PULL_SCRIPT: "pull",
    TOGETHER_SYNC_ARM_SCRIPT: "arm",
    TOGETHER_PROBE_SCRIPT: "probe",
    togetherButtonScript: () => "button",
    togetherButtonUpdateScript: () => "button",
    togetherButtonFailureScript: (message: string) => `button-failure:${message}`,
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    evaluateInPlayer: async (script: string) => {
      evaluations.push(script);
      if (script === "state") {
        stateReads += 1;
        return stateReads === 1 && options.firstState ? options.firstState : { ...page };
      }
      if (script === "leave" && options.leaveResult) return options.leaveResult;
      if (script === "leave" || script === "clear") {
        page = { ...page, status: "alone", inRoom: false, roomId: "", chatRoomId: "", creatorId: "", members: [] };
      }
      if (script === "pull") return options.remote ?? { serverInRoom: true, serverRoomId: "123456", serverUsers: page.members };
      return { ok: true };
    },
  }) as new () => Bridge;
  const bridge = new Class();
  bridge.timer = 1;
  bridge.identityApplied = true;
  bridge.started = true;
  bridge.lastInRoom = true;
  bridge.serverInRoom = true;
  bridge.serverRoomId = page.roomId;
  bridge.state = { ...page };
  return { bridge, evaluations, page };
}

describe("一起听退房生命周期", () => {
  it("退出请求失败时立即把错误回报给播放栏菜单", async () => {
    const { bridge, evaluations } = setup({ leaveResult: { ok: false, error: "网易云拒绝退出" } });
    bridge.leave();
    await flush();
    assert.equal(bridge.snapshot().note, "网易云拒绝退出");
    assert.equal(evaluations.includes("button-failure:网易云拒绝退出"), true);
  });

  it("主动退出立即清理设置页状态，之后不会自动恢复旧房间", async () => {
    const { bridge, evaluations } = setup();
    bridge.leave();
    assert.equal(bridge.snapshot().inRoom, false);
    assert.equal(bridge.snapshot().serverRoomId, "");
    assert.equal(bridge.lastInRoom, false);
    await flush();
    await bridge.tick();
    assert.equal(bridge.snapshot().status, "alone");
    assert.equal(evaluations.includes("restore"), false);
  });

  it("创建后等待成员时也可以解散房间", async () => {
    const { bridge, evaluations } = setup();
    bridge.state = {
      ...bridge.state,
      status: "waiting",
      inRoom: false,
      isHost: false,
      roomId: "123456",
    };
    bridge.leave();
    await flush();
    await bridge.tick();
    assert.equal(evaluations.includes("leave"), true);
    assert.equal(bridge.snapshot().inRoom, false);
  });

  it("读取状态尚未结束时点击退出，退房请求不会被 tick 收尾吞掉", async () => {
    let release!: (value: TogetherState) => void;
    const firstState = new Promise<TogetherState>(resolve => { release = resolve; });
    const { bridge, evaluations, page } = setup({ firstState });
    const reading = bridge.tick();
    bridge.leave();
    release(page);
    await reading;
    await flush();
    assert.equal(evaluations.filter(script => script === "leave").length, 1);
    assert.equal(bridge.pending, null);
    assert.equal(bridge.snapshot().inRoom, false);
    assert.equal(evaluations.includes("restore"), false);
  });

  it("手机端退出被服务端确认后清理网页，不恢复或重复结束房间", async () => {
    const { bridge, evaluations } = setup({ remote: { serverInRoom: false, serverChecked: true } });
    bridge.pullRemoteCommands();
    await flush();
    bridge.pullRemoteCommands();
    await flush();
    assert.equal(bridge.snapshot().inRoom, false);
    assert.equal(bridge.snapshot().serverRoomId, "");
    await bridge.tick();
    assert.equal(evaluations.includes("clear"), true);
    assert.equal(evaluations.includes("leave"), false);
    assert.equal(evaluations.includes("restore"), false);
  });

  it("房间状态请求失败不是确认退出，不能清理仍在进行的房间", async () => {
    const { bridge, evaluations } = setup({ remote: { serverInRoom: false, serverChecked: false } });
    bridge.pullRemoteCommands();
    await flush();
    bridge.pullRemoteCommands();
    await flush();
    assert.equal(bridge.snapshot().inRoom, true);
    assert.equal(evaluations.includes("clear"), false);
  });
});
