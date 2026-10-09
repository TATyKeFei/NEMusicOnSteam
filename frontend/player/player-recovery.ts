import { ChromeDevToolsProtocol } from "millennium";
import { isPlayerDocument } from "../constants.ts";
import { PLAYER_RECOVERY_SCRIPT, PLAYER_RETIRE_SCRIPT, type PlayerRecoverySnapshot } from "./player-recovery-player.ts";

async function waitForRetiredTarget(targetId: string, allowBlank = false): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const remaining = await ChromeDevToolsProtocol.send("Target.getTargets");
    const target = remaining.targetInfos.find((item: { targetId: string }) => item.targetId === targetId);
    if (target == null || (allowBlank && target.url === "about:blank")) return true;
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  return false;
}

async function closeRetiredTarget(targetId: string): Promise<void> {
  await ChromeDevToolsProtocol.send("Target.closeTarget", { targetId }).catch(() => {});
  if (await waitForRetiredTarget(targetId)) return;
  const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const navigated = await ChromeDevToolsProtocol.send("Page.navigate", { url: "about:blank" }, attached.sessionId);
    if (navigated.errorText) throw new Error(`无法卸载旧播放器：${navigated.errorText}`);
  } finally {
    await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
  }
  if (!await waitForRetiredTarget(targetId, true)) {
    throw new Error("等待旧播放器卸载超时，未新建页面以免重复播放");
  }
  void ChromeDevToolsProtocol.send("Target.closeTarget", { targetId }).catch(() => {});
}

export async function retirePlayerTargets(destroyNative?: () => void): Promise<PlayerRecoverySnapshot | null> {
  const targets = await ChromeDevToolsProtocol.send("Target.getTargets");
  let snapshot: PlayerRecoverySnapshot | null = null;
  const retiredTargets: string[] = [];
  for (const target of targets.targetInfos) {
    if (!isPlayerDocument(target.url)) continue;
    const attached = await ChromeDevToolsProtocol.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      const response = await ChromeDevToolsProtocol.send("Runtime.evaluate", {
        expression: PLAYER_RECOVERY_SCRIPT,
        returnByValue: true,
      }, attached.sessionId);
      const state = response.result?.value as { owned?: boolean; snapshot?: PlayerRecoverySnapshot | null } | null;
      if (response.exceptionDetails) throw new Error("无法读取旧播放器状态，未新建页面以免重复播放");
      if (!state?.owned) continue;
      const preferred = state.snapshot && (snapshot == null || (!snapshot.playing && state.snapshot.playing));
      if (preferred) snapshot = state.snapshot ?? null;
      if (preferred && state.snapshot?.current) {
        const saved = JSON.stringify({ snapshot: state.snapshot, savedAt: Date.now() });
        const checkpoint = await ChromeDevToolsProtocol.send("Runtime.evaluate", {
          expression: `localStorage.setItem('nemusic.onsteam.recovery.v1', ${JSON.stringify(saved)}); true`,
          returnByValue: true,
        }, attached.sessionId);
        if (checkpoint.exceptionDetails) throw new Error("无法保存原播放状态，未新建页面");
      }
      const retired = await ChromeDevToolsProtocol.send("Runtime.evaluate", {
        expression: PLAYER_RETIRE_SCRIPT,
        awaitPromise: true,
        returnByValue: true,
      }, attached.sessionId);
      if (retired.exceptionDetails || retired.result?.value !== true) {
        throw new Error("无法停止旧播放器，未新建页面以免重复播放");
      }
      retiredTargets.push(target.targetId);
    } finally {
      await ChromeDevToolsProtocol.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    }
  }
  destroyNative?.();
  for (const targetId of retiredTargets) await closeRetiredTarget(targetId);
  return snapshot;
}
