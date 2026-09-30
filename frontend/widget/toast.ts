import { createElement } from "react";
import { toaster } from "millennium";

/**
 * Steam's own toast popup (bottom-right, same renderer as achievement/friend toasts).
 * `toaster` is injected by Millennium's shared context; guard it because older
 * Millennium builds may not export it, and a failed popup must never break playback.
 *
 * The desktop toast reserves a friend-avatar-sized logo slot and starts the text right
 * after it, so the cover must stay at 40x40 — anything wider bleeds over the title.
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
