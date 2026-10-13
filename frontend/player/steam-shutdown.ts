import { sharedSteamClient, type SteamClient } from "./steam.ts";

export function registerSteamShutdown(callback: () => void, client: SteamClient | null = sharedSteamClient()): () => void {
  const register = client?.User?.RegisterForShutdownStart;
  if (typeof register !== "function") return () => {};
  let active = true;
  try {
    const registration = register.call(client.User, () => {
      if (!active) return;
      active = false;
      callback();
    });
    return () => {
      active = false;
      if (typeof registration === "function") registration();
      else registration?.unregister?.();
    };
  } catch (error) {
    active = false;
    console.warn("[NEMusic] Steam shutdown registration", error);
    return () => {};
  }
}
