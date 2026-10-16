import { ffi } from "millennium";
import { ExternalAudioBridge } from "./external-audio.ts";
import type { PlaybackOptions } from "./mpv.ts";
import type { MpdSettings } from "../settings.ts";

const getEndpoint = ffi<[], string>("mpd_endpoint");

export class MpdBridge extends ExternalAudioBridge {
  constructor(options: PlaybackOptions & { settings: () => MpdSettings }) {
    super({ ...options, name: "MPD", endpoint: getEndpoint, configuration: options.settings, supportsRate: false });
  }
}
