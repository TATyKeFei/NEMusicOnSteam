import { createElement } from "react";
import { toaster } from "millennium";

/**
 * Steam 自己的弹窗通知（右下角，和成就、好友通知用的是同一个渲染器）。
 * toaster 由 Millennium 的共享上下文注入；这里要判空，因为较老的 Millennium 版本
 * 可能没有导出它，而弹窗失败绝不能影响播放。
 *
 * 桌面端弹窗给 logo 预留的是好友头像大小的位置，文字紧接在它后面开始排，所以封面必须
 * 保持 40x40——再宽就会盖到标题上。
 */
export function steamToast(title: string, body: string, logoUrl?: string): void {
  try {
    if (typeof toaster?.toast !== "function") return;
    toaster.toast({
      title,
      body,
      logo: logoUrl
        ? createElement("img", {
            src: logoUrl,
            style: { width: "40px", height: "40px", objectFit: "cover", borderRadius: "3px" },
          })
        : undefined,
      duration: 5000,
      playSound: false,
    });
  } catch (error) {
    console.warn("[NEMusic] Steam toast", error);
  }
}
