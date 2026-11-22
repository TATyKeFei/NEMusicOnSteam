import { ChromeDevToolsProtocol } from "millennium";
import { isPlayerDocument } from "../constants.ts";
import { SNAPSHOT_SCRIPT, SNAPSHOT_WATCH_SCRIPT } from "./player-access.ts";
import type { TrackState } from "../mpris/mpris.ts";

export type EvaluateOptions = { userGesture?: boolean; awaitPromise?: boolean; fresh?: boolean; retrySafe?: boolean };

/** evaluateInPlayer 在网易云页面还没有 CDP target 时抛出。 */
export const PLAYER_TARGET_MISSING = "等待网易云播放器加载";

type PlayerSession = { targetId: string; sessionId: string };
type Outcome = { kind: "value"; value: unknown } | { kind: "missing" };

/**
 * 过去每个桥都在自己的每个 tick 上跑一遍 Target.getTargets 加 attach/detach。这些流量都
 * 要经过 Steam 主进程里的 CDP 客户端，于是几个 500ms～2s 的轮询器就变成了持续的风暴，
 * 和界面共享同一个主进程。改成只缓存一个会话、只 attach 一次，功能不变，IPC 降到零头。
 */
let session: PlayerSession | null = null;
let resolving: Promise<PlayerSession | null> | null = null;
let epoch = 0;
let selection: { marker: string; existingTargetIds: Set<string>; targetId: string | null; ready: boolean } | null = null;
const pageListeners = new Set<(event: Record<string, unknown>) => void>();
const playbackListeners = new Set<(state: TrackState) => void>();
let removeEventListener: (() => void) | null = null;
let stateSubscription: (() => void) | null = null;
let sharedState: { state: TrackState; at: number; maxAge: number } | null = null;
let statePending: Promise<unknown> | null = null;
let watchAttemptAt = -Infinity;
const traffic = { evaluations: 0, snapshotReads: 0, snapshotHits: 0, stateEvents: 0 };
export function playerTraffic(): typeof traffic { return { ...traffic }; }

export function listenPlaybackState(listener: (state: TrackState) => void): () => void {
  playbackListeners.add(listener);
  return () => { playbackListeners.delete(listener); };
}

async function enablePageEvents(sessionId: string): Promise<void> {
  await ChromeDevToolsProtocol.send("Runtime.enable", {}, sessionId);
  await ChromeDevToolsProtocol.send("Runtime.addBinding", { name: "__NEMusicOnSteamEvent" }, sessionId);
}

/** 通过 CDP binding 推送用户操作，不再每 120ms 查询一次按钮状态。 */
export function listenPlayerEvents(listener: (event: Record<string, unknown>) => void): (() => void) | null {
  if (typeof ChromeDevToolsProtocol.on !== "function") return null;
  pageListeners.add(listener);
  if (!removeEventListener) {
    removeEventListener = ChromeDevToolsProtocol.on("Runtime.bindingCalled", event => {
      if (event.name !== "__NEMusicOnSteamEvent" || event.sessionId !== session?.sessionId || event.payload.length > 4096) return;
      try {
        const value = JSON.parse(event.payload);
        if (value && typeof value === "object") for (const callback of pageListeners) callback(value);
      } catch {}
    });
  }
  if (session) void enablePageEvents(session.sessionId).catch(() => {});
  return () => {
    pageListeners.delete(listener);
    if (!pageListeners.size) { removeEventListener?.(); removeEventListener = null; }
  };
}

export async function preparePlayerTarget(marker: string): Promise<void> {
  releasePlayerSession();
  const current = { marker, existingTargetIds: new Set<string>(), targetId: null as string | null, ready: false };
  selection = current;
  const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
  if (selection !== current) return;
  current.existingTargetIds = new Set(targets.targetInfos.map((item: { targetId: string }) => item.targetId));
  current.ready = true;
}

function detach(sessionId: string): void {
  void ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId }).catch(() => {});
}

export function releasePlayerSession(): void {
  epoch++;
  const current = session;
  session = null;
  resolving = null;
  sharedState = null; statePending = null; watchAttemptAt = -Infinity;
  stateSubscription?.(); stateSubscription = null;
  if (current) detach(current.sessionId);
}

async function resolveSession(): Promise<PlayerSession | null> {
  if (selection != null && !selection.ready) return null;
  if (session) return session;
  if (resolving) return resolving;
  const started = epoch;
  const expected = selection;
  const pending = (async (): Promise<PlayerSession | null> => {
    const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
    if (epoch !== started) return null;
    const candidates = targets.targetInfos.filter((item: { url: string; targetId: string }) => {
      if (!isPlayerDocument(item.url)) return false;
      if (expected == null) return true;
      if (expected.targetId != null) return item.targetId === expected.targetId;
      return !expected.existingTargetIds.has(item.targetId);
    });
    const target = expected != null && candidates.length !== 1 ? null : candidates[0];
    if (!target) return null;
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    if (epoch !== started) {
      detach(attached.sessionId);
      return null;
    }
    if (expected != null && expected.targetId == null) {
      const source = `globalThis.__NEMusicOnSteamViewToken = ${JSON.stringify(expected.marker)};`;
      try {
        await ChromeDevToolsProtocol.send("Page.addScriptToEvaluateOnNewDocument", { source }, attached.sessionId);
        await ChromeDevToolsProtocol.send("Runtime.evaluate", { expression: source }, attached.sessionId);
      } catch (error) {
        detach(attached.sessionId);
        throw error;
      }
      if (epoch !== started) {
        detach(attached.sessionId);
        return null;
      }
      expected.targetId = target.targetId;
    }
    session = { targetId: target.targetId, sessionId: attached.sessionId };
    if (pageListeners.size) void enablePageEvents(attached.sessionId).catch(() => {});
    return session;
  })();
  resolving = pending;
  const clearResolving = () => {
    if (resolving === pending) resolving = null;
  };
  void pending.then(clearResolving, clearResolving);
  return pending;
}

async function evaluate(expression: string, options: EvaluateOptions): Promise<Outcome> {
  let sent = false;
  const request = async (): Promise<unknown> => {
    const current = await resolveSession();
    if (current == null) return null;
    traffic.evaluations++;
    sent = true;
    return ChromeDevToolsProtocol.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      userGesture: options.userGesture ?? false,
      awaitPromise: options.awaitPromise ?? false,
    }, current.sessionId);
  };
  // 响应丢失时页面可能已经执行了操作。只有发送前失败或明确可重放的读取才重试；
  // 下一首、播放暂停以及会取走按钮请求的脚本不能自动重放。
  let response: unknown;
  try {
    response = await request();
  } catch (error) {
    releasePlayerSession();
    const readOnly = options.retrySafe === true || (typeof SNAPSHOT_SCRIPT !== "undefined" && expression === SNAPSHOT_SCRIPT);
    if (sent && !readOnly) throw error;
    try {
      response = await request();
    } catch {
      throw error;
    }
  }
  if (response == null) return { kind: "missing" };
  const payload = response as { exceptionDetails?: { text: string; exception?: { description?: string } }; result: { value: unknown } };
  if (payload.exceptionDetails) {
    throw new Error(payload.exceptionDetails.exception?.description || payload.exceptionDetails.text);
  }
  return { kind: "value", value: payload.result.value };
}

export async function evaluateInPlayer(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
  const outcome = await evaluate(expression, options);
  if (outcome.kind === "missing") throw new Error(PLAYER_TARGET_MISSING);
  return outcome.value;
}

/** 与 evaluateInPlayer 相同，但页面不存在时返回 null 而不是抛异常。 */
export async function tryEvaluateInPlayer(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
  if (typeof SNAPSHOT_SCRIPT !== "undefined" && expression === SNAPSHOT_SCRIPT && typeof ChromeDevToolsProtocol.on === "function") {
    return readSharedState(options);
  }
  const outcome = await evaluate(expression, options);
  return outcome.kind === "missing" ? null : outcome.value;
}

async function readSharedState(options: EvaluateOptions): Promise<unknown> {
  traffic.snapshotReads++;
  if (!stateSubscription) stateSubscription = listenPlayerEvents(event => {
    const state = event.state as TrackState | undefined;
    if (event.type !== "playback-state" || !state || typeof state.trackId !== "string"
      || !Number.isFinite(state.position) || !Number.isFinite(state.duration)
      || !["Playing", "Paused", "Stopped"].includes(state.playbackStatus)) return;
    sharedState = { state, at: Date.now(), maxAge: 2500 }; traffic.stateEvents++;
    for (const listener of playbackListeners) listener({ ...state });
  });
  if (!options.fresh && sharedState && Date.now() - sharedState.at < sharedState.maxAge) {
    traffic.snapshotHits++;
    const { state, at } = sharedState;
    return { ...state, position: state.playbackStatus === "Playing"
      ? Math.min(state.duration || Infinity, state.position + (Date.now() - at) / 1000 * (state.rate || 1)) : state.position };
  }
  if (!options.fresh && statePending) { traffic.snapshotHits++; return statePending; }
  const generation = epoch;
  const previousState = sharedState;
  const pending = (async () => {
    if (Date.now() - watchAttemptAt >= 10000) {
      watchAttemptAt = Date.now();
      try {
        const current = await resolveSession();
        if (current) {
          await enablePageEvents(current.sessionId);
          await evaluate(SNAPSHOT_WATCH_SCRIPT, {});
        }
      } catch { /* 旧版 Steam 不支持事件绑定时继续读取快照。 */ }
    }
    const outcome = await evaluate(SNAPSHOT_SCRIPT, { ...options, retrySafe: true });
    const state = outcome.kind === "value" ? outcome.value as TrackState | null : null;
    if (epoch === generation && state && typeof state.trackId === "string" && sharedState === previousState) {
      sharedState = { state, at: Date.now(), maxAge: 300 };
    }
    return state ? { ...state } : null;
  })();
  statePending = pending;
  const clear = () => { if (statePending === pending) statePending = null; };
  void pending.then(clear, clear);
  return pending;
}
