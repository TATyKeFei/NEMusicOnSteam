import { ffi } from "millennium";
import { ExternalAudioBridge, type ExternalAudioOptions } from "./external-audio.ts";
import type { PlaybackBackend } from "../settings.ts";

const getEndpoint = ffi<[], string>("mpv_endpoint");
export type PlaybackOptions = Omit<ExternalAudioOptions, "name" | "endpoint" | "configuration">;

export class MpvBridge extends ExternalAudioBridge {
  constructor(options: PlaybackOptions) {
    super({ ...options, name: "mpv", endpoint: getEndpoint });
  }
}

export function playbackBackendLabel(value: PlaybackBackend): string {
  return value === "mpv" ? "mpv" : value === "mpd" ? "MPD" : "内嵌网页播放器";
}
