import { ffi } from "millennium";
import { HelperClient } from "./helper-client.ts";

/** 下载、识曲和媒体控制共用一个进程，端口与令牌也必须一起更新。 */
export const mprisHelper = new HelperClient(
  ffi<[], string>("mpris_endpoint"),
  ffi<[], string>("mpris_reconnect"),
);
