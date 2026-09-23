export const BROWSER_VIEW_STACK_TOP = 1;

export type BrowserView = {
  SetBounds: (x: number, y: number, width: number, height: number) => void;
  SetVisible: (visible: boolean) => void;
  SetFocus?: (focused: boolean) => void;
  SetWindowStackingOrder?: (order: number) => void;
  NotifyUserActivation?: () => void;
  LoadURL?: (url: string) => void;
  Reload?: () => void;
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
};

export type BrowserViewCreateOptions = {
  parentPopupBrowserID?: number;
  strInitialURL?: string;
  strName?: string;
  strUserAgentIdentifier?: string;
  strUserAgentOverride?: string;
  bOnlyAllowTrustedPopups?: boolean;
  bPreventCloseFromJavascript?: boolean;
};

export type SteamClient = {
  Browser?: {
    GetBrowserID?: () => number;
    NotifyUserActivation?: () => void;
    SetBackgroundThrottlingDisabled?: (disabled: boolean) => void;
  };
  BrowserView?: {
    Create?: (options: BrowserViewCreateOptions) => BrowserView;
    Destroy?: (view: BrowserView) => void;
  };
};

export type SteamWindow = Window & {
  SteamClient?: SteamClient;
};

export type SteamPopup = {
  window?: SteamWindow;
  GetName?: () => string;
  BIsClosed?: () => boolean;
  BIsValid?: () => boolean;
  params?: { name?: string };
  RegisterChildBrowserView?: (view: BrowserView) => { Unregister?: () => void } | undefined;
};

export type PopupManager = {
  GetExistingPopup?: (name: string) => SteamPopup | undefined;
  GetPopups?: () => Iterable<SteamPopup>;
};

type SteamGlobals = typeof globalThis & {
  SteamClient?: SteamClient;
  g_PopupManager?: PopupManager;
};

export function steamGlobals(): SteamGlobals {
  return globalThis as SteamGlobals;
}

export function sharedSteamClient(): SteamClient | null {
  return steamGlobals().SteamClient ?? null;
}

export function browserId(client: SteamClient | null | undefined): number | null {
  const readId = client?.Browser?.GetBrowserID;
  if (typeof readId !== "function") return null;
  const id = readId.call(client.Browser);
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

export function setBackgroundThrottlingDisabled(client: SteamClient | null | undefined, disabled: boolean): boolean {
  const setDisabled = client?.Browser?.SetBackgroundThrottlingDisabled;
  if (typeof setDisabled !== "function") return false;
  setDisabled.call(client.Browser, disabled);
  return true;
}

function popupName(popup: SteamPopup): string {
  const named = popup.GetName?.();
  if (typeof named === "string" && named !== "") return named;
  return popup.params?.name ?? "";
}

export function isUsablePopup(popup: SteamPopup | null | undefined): popup is SteamPopup & { window: SteamWindow } {
  if (popup?.window == null || popup.window.closed) return false;
  if (popup.BIsClosed?.() === true) return false;
  if (popup.BIsValid != null && popup.BIsValid() === false) return false;
  return true;
}

export function findMainPopup(manager: PopupManager | null | undefined = steamGlobals().g_PopupManager): (SteamPopup & { window: SteamWindow }) | null {
  if (manager == null) return null;
  const direct = manager.GetExistingPopup?.("SP Desktop");
  if (isUsablePopup(direct)) return direct;
  const popups = manager.GetPopups?.();
  if (popups == null) return null;
  for (const popup of Array.from(popups)) {
    const name = popupName(popup);
    if (name !== "SP Desktop" && !name.startsWith("SP Desktop")) continue;
    if (isUsablePopup(popup)) return popup;
  }
  return null;
}
