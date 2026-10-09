import { ChromeDevToolsProtocol } from "millennium";
import { isPlayerDocument } from "../constants.ts";

export type EvaluateOptions = { userGesture?: boolean; awaitPromise?: boolean };

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
  const request = async (): Promise<unknown> => {
    const current = await resolveSession();
    if (current == null) return null;
    return ChromeDevToolsProtocol.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      userGesture: options.userGesture ?? false,
      awaitPromise: options.awaitPromise ?? false,
    }, current.sessionId);
  };
  // send 被 reject 说明缓存的会话已经失效（页面刷新、跳转、视图关闭），而不是页面抛了
  // 异常：丢掉它并重新 attach 一次。exceptionDetails 是一次成功往返的结果，
  // 不能因此触发同样的反复重连。
  let response: unknown;
  try {
    response = await request();
  } catch (error) {
    releasePlayerSession();
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
  const outcome = await evaluate(expression, options);
  return outcome.kind === "missing" ? null : outcome.value;
}
