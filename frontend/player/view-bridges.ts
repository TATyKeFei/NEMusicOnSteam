type ViewBridge = { setEnabled(enabled: boolean): void };

/** 页面桥必须成组启停，避免窗口恢复和主动关闭漏掉不同的功能。 */
export class ViewBridges {
  private readonly bridges: readonly ViewBridge[];

  constructor(bridges: readonly ViewBridge[]) {
    this.bridges = bridges;
  }

  setEnabled(enabled: boolean): void {
    for (const bridge of this.bridges) bridge.setEnabled(enabled);
  }
}
