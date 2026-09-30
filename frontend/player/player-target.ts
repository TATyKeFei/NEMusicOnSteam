import { ChromeDevToolsProtocol } from "millennium";
import { isPlayerDocument } from "../constants.ts";

export type EvaluateOptions = { userGesture?: boolean; awaitPromise?: boolean };

/** Thrown by evaluateInPlayer when the NetEase page has no CDP target yet. */
export const PLAYER_TARGET_MISSING = "等待网易云播放器加载";

type PlayerSession = { targetId: string; sessionId: string };
type Outcome = { kind: "value"; value: unknown } | { kind: "missing" };

/**
 * Every bridge used to run its own Target.getTargets + attach/detach cycle on each tick.
 * That traffic runs through the CDP client inside the Steam main process, so a handful of
 * 500ms-2s pollers turned into a steady storm that shared the main process with the UI.
 * One cached session, attached once, keeps the same functionality at a fraction of the IPC.
 */
let session: PlayerSession | null = null;
let resolving: Promise<PlayerSession | null> | null = null;
let epoch = 0;

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
  if (session) return session;
  if (resolving) return resolving;
  const started = epoch;
  const pending = (async (): Promise<PlayerSession | null> => {
    const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
    const target = targets.targetInfos.find((item: { url: string; targetId: string }) => isPlayerDocument(item.url));
    if (!target) return null;
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    if (epoch !== started) {
      detach(attached.sessionId);
      return null;
    }
    session = { targetId: target.targetId, sessionId: attached.sessionId };
    return session;
  })();
  resolving = pending;
  void pending.finally(() => {
    if (resolving === pending) resolving = null;
  });
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
  // A rejected send means the cached session went stale (page reload, navigation, closed
  // view), not that the page threw: drop it and reattach once. exceptionDetails is a
  // successful round trip, so it must not trigger the same churn.
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

/** Same as evaluateInPlayer, but resolves to null instead of throwing when the page is absent. */
export async function tryEvaluateInPlayer(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
  const outcome = await evaluate(expression, options);
  return outcome.kind === "missing" ? null : outcome.value;
}
