/**
 * 网易云网页版对外上报的身份挂在全局 `window.APP_CONF` 上（os / osver / appver / deviceId /
 * clientSign），eapi 请求体里那个 `header` 字段就是直接从这个对象读的——各模块里的 `f.a`、
 * `o.a`、`v.a` 和 `window.APP_CONF` 是同一个对象引用（`t.a=w; window.APP_CONF=w`），所以改
 * 这里就能改我们建房时报出去的身份。
 *
 * 但只改 APP_CONF 是不够的：一起听那套接口（/api/listen/together/*）走的是 weapi，weapi 的
 * 请求体里**从来不带** os/appver，页面的请求层只加了一个 `x-music-web-os: web3` 头。服务端
 * 看到的客户端版本来自 **cookie**——页面启动时有个 resetCookies 会拿 APP_CONF 的值写
 * os/deviceId/osver/appver/clientSign/channel/mode 这几个 cookie，写在 music.163.com 和
 * interface.music.163.com 两个域上（weapi 实际打到 interface.music.163.com，且
 * credentials:"include"）。resetCookies 只在启动时跑一次，所以我们把 APP_CONF 改掉之后，
 * cookie 里还是网页版原值 10.0.5.200451，服务端就还是把建房的人当成老版本，于是另一端加不
 * 进来，提示「对方当前版本较低」。
 *
 * 所以这里要做两件事：改 APP_CONF（管 eapi），并且同步改 cookie（管 weapi）。cookie 用
 * `.music.163.com` 这个父域写一份，两个子域都覆盖得到；写之前先删掉原生那份 host-only 的，
 * 否则同名 cookie 会发两份，服务端取哪份是未定义行为。
 *
 * deviceId 不进 cookie：它和登录会话绑在一起，pc-clean 已经证明改它会直接建不了房。
 *
 * 为什么需要这个：一起听建房能成，但别人（手机端、别的插件用户）加入时会被服务端按客户端
 * 版本拦下来，提示「对方当前版本较低」。网页版报的是 `10.0.5.200451`，这个号对不上任何真实
 * 客户端——3.x 是新架构、2.10.x 是旧架构、10.x 谁都不是。所以第一件事是报成一个真实存在
 * 而且官方已知支持一起听的版本。
 *
 * 变体只挑有权威来源的：
 *   pc-latest  只改 appver，os 不动——影响面最小
 *   pc-clean   另外把 osver: "DevServer"、deviceId: "Mock.getDeviceId" 这两个明显的桩换成
 *              合理值。这两个太扎眼，服务端风控单独认它们也不是没可能。
 *   android    报成安卓客户端。os + appver 有权威来源（用户手机实测的 9.6.06），但安卓的
 *              osver 长什么样没有权威来源，所以 osver 和 deviceId 一律保持原样——pc-clean
 *              已经证明了乱动 deviceId 会直接建不了房。标成实验性。
 *
 * 没有权威来源的版本号宁可不写，编一个只会把问题变成「为什么这个版本不行」。
 */

/** 网页版实际在报的身份（未登录启动时读到的，15 秒内不会被覆盖）。 */
export const IDENTITY_BASELINE = {
  os: "pc",
  osver: "DevServer",
  appver: "10.0.5.200451",
  deviceId: "Mock.getDeviceId",
} as const;

/** 源自 https://music.163.com/api/pc/package/download/latest?productName=music 的 appVer + buildVer。 */
export const PC_LATEST_VERSION = "3.1.40.205461";

/** 源自用户手机上跑的网易云安卓端实测上报值。 */
export const ANDROID_APP_VERSION = "9.6.06";

export type IdentityVariant = "off" | "pc-latest" | "pc-clean" | "android";

export const IDENTITY_VARIANTS: readonly IdentityVariant[] = ["off", "pc-latest", "pc-clean", "android"];

export const IDENTITY_LABELS: Record<IdentityVariant, string> = {
  "off": `不改（原样 ${IDENTITY_BASELINE.appver}）`,
  "pc-latest": `报成最新官方 Windows 客户端 ${PC_LATEST_VERSION}`,
  "pc-clean": `同上，并清掉 DevServer / Mock 桩`,
  "android": `实验：报成安卓客户端 ${ANDROID_APP_VERSION}`,
};

/** 覆盖到的字段。没进变体的字段每次都会还原，否则从 pc-clean 切回 pc-latest 会把 deviceId 留在半路。 */
const FIELDS = ["os", "osver", "appver", "deviceId"];

/**
 * 要落到 cookie 的字段。deviceId 故意不在里面：它跟登录会话绑定，pc-clean 已经证明改它会
 * 直接建不了房，而它又不是版本校验要用的东西。
 */
const COOKIE_KEYS = ["os", "osver", "appver"] as const;

/** apply / read 两个脚本共用的 cookie 读写。跨脚本字符串拼接，抽成常量免得两处跑偏。 */
const COOKIE_HELPERS = `  const COOKIE_KEYS = ${JSON.stringify(COOKIE_KEYS)};
  // 页面在 music.163.com 上，写父域 cookie 就同时覆盖 music.163.com 和
  // interface.music.163.com —— weapi 实际打到后者。
  const COOKIE_DOMAIN = '.music.163.com';
  const hasDocument = () => typeof document === 'object' && document !== null;
  const readCookie = () => {
    const out = {};
    if (!hasDocument() || typeof document.cookie !== 'string') return out;
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      if (!COOKIE_KEYS.includes(name)) continue;
      let value = part.slice(eq + 1).trim();
      try { value = decodeURIComponent(value); } catch (error) { value = part.slice(eq + 1).trim(); }
      // 同名可能有多份（原生那份 host-only 加我们这份父域），全部留着才能看出重复。
      if (name in out) out[name] = [].concat(out[name], value);
      else out[name] = [value];
    }
    return out;
  };
  const writeCookie = (name, value) => {
    if (!hasDocument()) return;
    // 先删干净：父域的那份、我们自己上次写的、以及原生写的 host-only 那份。
    // 留着同名重复 cookie 的话服务端取哪一份是未定义行为。
    document.cookie = name + '=; domain=' + COOKIE_DOMAIN + '; path=/; max-age=0';
    document.cookie = name + '=; path=/; max-age=0';
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(String(value))
      + '; domain=' + COOKIE_DOMAIN + '; path=/; max-age=31536000';
  };
`;

/**
 * 应用变体，返回回读结果——回读是为了让设置页能真的显示「现在报的是什么」，而不是
 * 相信我们写进去了。
 *
 * 写法上刻意不用直接赋值：页面给这些字段装了 setter，赋值会走它自己的
 * `C.error("APP_CONF","useless update…")` 日志。改成自己 defineProperty 接管之后，getter
 * 永远返回目标值、setter 直接吞掉——顺带也就防住了页面那个异步写入器把值改回去。
 * 原始描述符第一次碰之前就存进 globalThis，要还原只能连描述符一起还回去（原来的 getter/setter
 * 带着页面自己的闭包状态）。
 */
export const TOGETHER_IDENTITY_APPLY_SCRIPT = (variant: IdentityVariant, deviceId: string): string => `(() => {
  const conf = window.APP_CONF;
  if (!conf || typeof conf !== 'object') return { ok: false, note: '页面里没有 APP_CONF' };
  const FIELDS = ${JSON.stringify(FIELDS)};
  const BASELINE = ${JSON.stringify(IDENTITY_BASELINE)};
${COOKIE_HELPERS}  const variant = ${JSON.stringify(variant)};
  const storeKey = '__NEMusicOnSteamIdentity';
  const own = globalThis[storeKey] || (globalThis[storeKey] = { orig: {} });
  const snapshot = () => {
    for (const key of FIELDS) {
      if (key in own.orig) continue;
      // in 判断要包含值为 undefined 的情况，所以存对象而不是直接存值。
      own.orig[key] = { desc: Object.getOwnPropertyDescriptor(conf, key), value: conf[key] };
    }
  };
  const restore = (key) => {
    const saved = own.orig[key];
    if (!saved) return;
    if (saved.desc) Object.defineProperty(conf, key, saved.desc);
    else delete conf[key];
  };
  const target = variant === 'pc-latest'
    ? { appver: ${JSON.stringify(PC_LATEST_VERSION)} }
    : variant === 'pc-clean'
      ? {
          appver: ${JSON.stringify(PC_LATEST_VERSION)},
          osver: 'Microsoft-Windows-11-Professional-build-22631-64bit',
          deviceId: ${JSON.stringify(deviceId)},
        }
      : variant === 'android'
        ? { os: 'android', appver: ${JSON.stringify(ANDROID_APP_VERSION)} }
        : {};
  snapshot();
  if (variant === 'off') {
    for (const key of FIELDS) restore(key);
  } else {
    for (const key of Object.keys(target)) {
      const value = target[key];
      Object.defineProperty(conf, key, {
        get: () => value,
        set: () => {},
        configurable: true,
        enumerable: true,
      });
    }
    // 切换变体时把这次不涉及的字段还原，避免上一个变体的残留留下来。
    for (const key of FIELDS) if (!(key in target)) restore(key);
  }
  own.variant = variant;
  // cookie 也要跟上。weapi 不看 APP_CONF，只看 cookie；不改这里的话我们改的 appver 根本没
  // 上过线。变体没覆盖到的字段写回基线值，保持 cookie 和 APP_CONF 自洽。
  const cookieTarget = variant === 'off' ? {} : target;
  for (const key of COOKIE_KEYS) writeCookie(key, key in cookieTarget ? cookieTarget[key] : BASELINE[key]);
  let readback;
  try {
    readback = { os: String(conf.os), osver: String(conf.osver), appver: String(conf.appver), deviceId: String(conf.deviceId) };
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, variant, ...readback, cookie: readCookie() };
})()`;

/** 回传给宿主的身份快照。 */
export type IdentitySnapshot = {
  ok: boolean;
  variant: IdentityVariant | "";
  os: string;
  osver: string;
  appver: string;
  deviceId: string;
  /** 页面上真正读得到的 cookie 值。同名有多份时用 | 拼开——重复本身就是问题。 */
  cookie: Record<string, string>;
  note: string;
};

export const IDENTITY_IDLE: IdentitySnapshot = {
  ok: false,
  variant: "",
  os: "",
  osver: "",
  appver: "",
  deviceId: "",
  cookie: {},
  note: "还没读到页面身份",
};

/** cookie 里同名多份时拼成 "a|b"，方便在设置页一眼看出重复。 */
function flattenCookie(value: unknown): Record<string, string> {
  if (value == null || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) continue;
    out[key] = (Array.isArray(raw) ? raw : [raw]).map((item) => String(item)).join("|");
  }
  return out;
}

/** 归一化 CDP 回来的结果，和 recognition 那边的 report 一个套路。 */
export function normalizeIdentity(value: unknown, fallbackVariant: IdentityVariant): IdentitySnapshot {
  const source = (value ?? null) as Record<string, unknown> | null;
  if (!source || typeof source !== "object") {
    return { ...IDENTITY_IDLE, variant: fallbackVariant, note: "读取页面身份失败" };
  }
  const ok = source.ok === true;
  const pick = (key: string): string => (source[key] == null ? "" : String(source[key]));
  const note = ok
    ? ""
    : pick("note") || "读取页面身份失败";
  const variant = pick("variant");
  return {
    ok,
    variant: (IDENTITY_VARIANTS as readonly string[]).includes(variant) ? (variant as IdentityVariant) : fallbackVariant,
    os: pick("os"),
    osver: pick("osver"),
    appver: pick("appver"),
    deviceId: pick("deviceId"),
    cookie: flattenCookie(source.cookie),
    note,
  };
}
