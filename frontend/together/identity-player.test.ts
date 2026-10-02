import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { describe, it } from "node:test";
import {
  ANDROID_APP_VERSION,
  IDENTITY_BASELINE,
  IDENTITY_IDLE,
  PC_LATEST_VERSION,
  TOGETHER_IDENTITY_APPLY_SCRIPT,
  TOGETHER_IDENTITY_READ_SCRIPT,
  normalizeIdentity,
  type IdentityVariant,
} from "./identity-player.ts";

/** vm 造出来的对象原型和测试进程不是一回事，深比较前先拍平。 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 照页面的样子造一个 APP_CONF：每个字段都装了 getter/setter，setter 会打日志再写值。
 * 页面那份的真实实现是 `set(r){ C.error("APP_CONF","useless update…"); t=r }`，
 * 所以「补丁生效」的标准是既读到新值、又一次都没调到原 setter。
 */
function makeConf() {
  const store: Record<string, string> = {
    os: IDENTITY_BASELINE.os,
    osver: IDENTITY_BASELINE.osver,
    appver: IDENTITY_BASELINE.appver,
    deviceId: IDENTITY_BASELINE.deviceId,
    channel: "others",
  };
  const setterCalls: string[] = [];
  const conf: Record<string, unknown> = {};
  for (const key of Object.keys(store)) {
    Object.defineProperty(conf, key, {
      get: () => store[key],
      set: (value: string) => {
        setterCalls.push(`${key}=${value}`);
        store[key] = value;
      },
      configurable: true,
      enumerable: true,
    });
  }
  return { conf, store, setterCalls };
}

/**
 * 够用的 cookie 罐：认 domain 和 max-age=0 就够了。这里刻意模拟真实浏览器里
 * 「同名 cookie 会因为 domain 不同而并存」的行为——补丁要是不先删干净，写出去就是两份。
 */
function makeDocument(seed: { name: string; value: string; domain: string }[] = []) {
  const host = "music.163.com";
  const jar = new Map<string, string>();
  for (const item of seed) jar.set(`${item.domain}|${item.name}`, item.value);
  const document = {
    get cookie(): string {
      return [...jar].map(([key, value]) => `${key.slice(key.indexOf("|") + 1)}=${value}`).join("; ");
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const attr = new Map(attrs.map(item => item.trim().split("=")));
      const domain = attr.get("domain") || host;
      const key = `${domain}|${name}`;
      // max-age=0 是删除。没带 domain 的那条只碰 host 自己那份，和真实浏览器一致。
      if (String(attr.get("max-age")) === "0") {
        jar.delete(key);
        return;
      }
      jar.set(key, value);
    },
  };
  return { document, jar };
}

/** 同一个 context 连着跑，globalThis 上的 orig 快照才留得住——这和页面里跨调用的状态一致。 */
function player(conf: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const sandbox: Record<string, unknown> = { window: {}, ...extra };
  if (conf) (sandbox.window as Record<string, unknown>).APP_CONF = conf;
  const context = createContext(sandbox);
  return <T,>(script: string) => plain(runInContext(script, context)) as T;
}

const DEVICE_ID = "0123456789abcdef";

function apply(run: <T,>(s: string) => T, variant: IdentityVariant) {
  return run<{ ok: boolean; variant: string; os: string; osver: string; appver: string; deviceId: string }>(
    TOGETHER_IDENTITY_APPLY_SCRIPT(variant, DEVICE_ID),
  );
}

describe("一起听身份补丁", () => {
  it("pc-latest 只改 appver，os 和 osver 原封不动", () => {
    const { conf, store, setterCalls } = makeConf();
    const run = player(conf);
    const result = apply(run, "pc-latest");
    assert.equal(result.ok, true);
    assert.equal(result.variant, "pc-latest");
    assert.equal(result.appver, PC_LATEST_VERSION);
    assert.equal(result.os, IDENTITY_BASELINE.os);
    assert.equal(result.osver, IDENTITY_BASELINE.osver);
    // 补丁读 conf（我们的 getter），页面自己的后备值 store 压根没被写过。
    assert.equal((conf as Record<string, string>).deviceId, IDENTITY_BASELINE.deviceId);
    assert.equal(store.deviceId, IDENTITY_BASELINE.deviceId);
    assert.equal(store.appver, IDENTITY_BASELINE.appver, "页面那份数据被改写了");
    // 页面那个 setter 一次都不能被调到，否则会打 "useless update" 日志。
    assert.deepEqual(setterCalls, []);
  });

  it("pc-clean 把 DevServer 和 Mock 桩也换掉", () => {
    const { conf, setterCalls } = makeConf();
    const result = apply(player(conf), "pc-clean");
    assert.equal(result.ok, true);
    assert.equal(result.appver, PC_LATEST_VERSION);
    assert.equal(result.deviceId, DEVICE_ID);
    assert.match(result.osver, /^Microsoft-Windows/);
    assert.doesNotMatch(result.osver, /DevServer/);
    assert.doesNotMatch(result.deviceId, /Mock/);
    assert.deepEqual(setterCalls, []);
  });

  it("android 只改 os 和 appver，osver / deviceId 保持原样", () => {
    const { conf, setterCalls } = makeConf();
    const result = apply(player(conf), "android");
    assert.equal(result.ok, true);
    assert.equal(result.variant, "android");
    assert.equal(result.os, "android");
    assert.equal(result.appver, ANDROID_APP_VERSION);
    // 安卓的 osver 长什么样没有权威来源，deviceId 又被证明一动就建不了房，两个都不碰。
    assert.equal(result.osver, IDENTITY_BASELINE.osver);
    assert.equal(result.deviceId, IDENTITY_BASELINE.deviceId);
    assert.deepEqual(setterCalls, []);
  });

  it("从 android 切回 pc-latest 会把 os 还原", () => {
    const { conf } = makeConf();
    const run = player(conf);
    assert.equal(apply(run, "android").os, "android");
    const downgraded = apply(run, "pc-latest");
    assert.equal(downgraded.os, IDENTITY_BASELINE.os);
    assert.equal(downgraded.appver, PC_LATEST_VERSION);
  });
  it("回读就是读 conf 本身，不是我们写进去的目标值", () => {
    const { conf } = makeConf();
    const run = player(conf);
    const applied = apply(run, "pc-latest");
    const read = run<{ ok: boolean; appver: string }>(TOGETHER_IDENTITY_READ_SCRIPT);
    assert.equal(read.ok, true);
    assert.equal(read.appver, applied.appver);
    assert.equal(read.appver, PC_LATEST_VERSION);
  });

  it("重复应用是幂等的", () => {
    const { conf } = makeConf();
    const run = player(conf);
    const first = apply(run, "pc-clean");
    const second = apply(run, "pc-clean");
    assert.deepEqual(second, first);
  });

  it("还原到 off：值和原来的访问器一起还回去", () => {
    const { conf, store, setterCalls } = makeConf();
    const run = player(conf);
    apply(run, "pc-clean");
    const restored = apply(run, "off");
    assert.equal(restored.ok, true);
    assert.equal(restored.appver, IDENTITY_BASELINE.appver);
    assert.equal(restored.osver, IDENTITY_BASELINE.osver);
    assert.equal(restored.deviceId, IDENTITY_BASELINE.deviceId);
    // 描述符要真的还回成访问器形态，否则页面以后自己写这个字段就写不进去了。
    for (const key of ["os", "osver", "appver", "deviceId"]) {
      const desc = Object.getOwnPropertyDescriptor(conf, key);
      assert.equal(typeof desc?.get, "function", `${key} 的 getter 没还原`);
      assert.equal(typeof desc?.set, "function", `${key} 的 setter 没还原`);
    }
    // 还原之后页面自己赋值要重新生效。
    (conf as Record<string, unknown>).appver = "2.10.13.202675";
    assert.equal(store.appver, "2.10.13.202675");
    assert.deepEqual(setterCalls, ["appver=2.10.13.202675"]);
  });

  it("从 pc-clean 切到 pc-latest 会把 deviceId 还原，不留残渣", () => {
    const { conf, store } = makeConf();
    const run = player(conf);
    apply(run, "pc-clean");
    const read = () => conf as Record<string, string>;
    assert.equal(read().deviceId, DEVICE_ID, "pc-clean 应当已经把 deviceId 报出去了");
    const downgraded = apply(run, "pc-latest");
    assert.equal(downgraded.appver, PC_LATEST_VERSION);
    assert.equal(read().deviceId, IDENTITY_BASELINE.deviceId, "deviceId 是上一个变体的残留");
    assert.equal(read().osver, IDENTITY_BASELINE.osver, "osver 是上一个变体的残留");
    assert.equal(store.deviceId, IDENTITY_BASELINE.deviceId);
  });

  it("off 先于任何应用时也不报错", () => {
    const { conf } = makeConf();
    const result = apply(player(conf), "off");
    assert.equal(result.ok, true);
    assert.equal(result.appver, IDENTITY_BASELINE.appver);
  });

  it("页面里没有 APP_CONF 时报错而不是抛异常", () => {
    const run = player(null);
    const result = run<{ ok: boolean; note: string }>(TOGETHER_IDENTITY_APPLY_SCRIPT("pc-latest", DEVICE_ID));
    assert.equal(result.ok, false);
    assert.match(result.note, /APP_CONF/);
    const read = run<{ ok: boolean; note: string }>(TOGETHER_IDENTITY_READ_SCRIPT);
    assert.equal(read.ok, false);
    assert.match(read.note, /APP_CONF/);
  });

  it("读脚本能看到当前生效的是哪个变体", () => {
    const { conf } = makeConf();
    const run = player(conf);
    assert.equal(run<{ variant: string }>(TOGETHER_IDENTITY_READ_SCRIPT).variant, "off");
    apply(run, "pc-latest");
    assert.equal(run<{ variant: string }>(TOGETHER_IDENTITY_READ_SCRIPT).variant, "pc-latest");
    apply(run, "off");
    assert.equal(run<{ variant: string }>(TOGETHER_IDENTITY_READ_SCRIPT).variant, "off");
  });
});

describe("一起听身份 cookie", () => {
  /** 原生 resetCookies 会在启动时先写一份 host-only 的，这些就是那份。 */
  function nativeCookie() {
    return [
      { name: "os", value: IDENTITY_BASELINE.os, domain: "music.163.com" },
      { name: "osver", value: IDENTITY_BASELINE.osver, domain: "music.163.com" },
      { name: "appver", value: IDENTITY_BASELINE.appver, domain: "music.163.com" },
      { name: "deviceId", value: IDENTITY_BASELINE.deviceId, domain: "music.163.com" },
    ];
  }

  function cookieRun(conf: Record<string, unknown>, seed = nativeCookie()) {
    const jar = makeDocument(seed);
    const run = player(conf, { document: jar.document });
    return { run, jar };
  }

  it("weapi 只看 cookie，所以 appver 必须真的写进去", () => {
    const { conf } = makeConf();
    const { run, jar } = cookieRun(conf);
    const result = apply(run, "pc-latest");
    assert.equal(jar.jar.get(".music.163.com|appver"), PC_LATEST_VERSION);
    // 变体没覆盖到的字段写回基线，cookie 和 APP_CONF 得自洽。
    assert.equal(jar.jar.get(".music.163.com|os"), IDENTITY_BASELINE.os);
    assert.deepEqual(result.cookie.appver, [PC_LATEST_VERSION]);
  });

  it("先把原生那份 host-only 的删掉，不留同名两份", () => {
    const { conf } = makeConf();
    const { run, jar } = cookieRun(conf);
    apply(run, "pc-latest");
    assert.equal(jar.jar.has("music.163.com|appver"), false, "host-only 那份没删掉");
    // deviceId 不归我们管，原生那份得原样留着。
    assert.equal(jar.jar.get("music.163.com|deviceId"), IDENTITY_BASELINE.deviceId);
  });

  it("反复应用不会越堆越多", () => {
    const { conf } = makeConf();
    const { run } = cookieRun(conf);
    apply(run, "pc-latest");
    const second = apply(run, "pc-latest");
    assert.deepEqual(second.cookie.appver, [PC_LATEST_VERSION], JSON.stringify(second.cookie));
  });

  it("android 变体把 os 也写上", () => {
    const { conf } = makeConf();
    const { run, jar } = cookieRun(conf);
    apply(run, "android");
    assert.equal(jar.jar.get(".music.163.com|os"), "android");
    assert.equal(jar.jar.get(".music.163.com|appver"), ANDROID_APP_VERSION);
  });

  it("切回 off 把 cookie 也还原成基线", () => {
    const { conf } = makeConf();
    const { run, jar } = cookieRun(conf);
    apply(run, "pc-latest");
    apply(run, "off");
    assert.equal(jar.jar.get(".music.163.com|appver"), IDENTITY_BASELINE.appver);
    assert.equal(jar.jar.get(".music.163.com|os"), IDENTITY_BASELINE.os);
  });

  it("page 上没有 document 时不炸，只是不写 cookie", () => {
    const { conf } = makeConf();
    const result = apply(player(conf), "pc-latest");
    assert.equal(result.ok, true);
    assert.deepEqual(result.cookie, {});
  });

  it("同名多份会在回读里用 | 拼出来", () => {
    const { conf } = makeConf();
    const { run } = cookieRun(conf, [
      { name: "appver", value: "stale-host-only", domain: "music.163.com" },
      { name: "appver", value: "stale-domain", domain: ".music.163.com" },
    ]);
    const read = run<{ cookie: Record<string, string[]> }>(TOGETHER_IDENTITY_READ_SCRIPT);
    assert.deepEqual(read.cookie.appver, ["stale-host-only", "stale-domain"]);
    const snapshot = normalizeIdentity(read, "off");
    assert.equal(snapshot.cookie.appver, "stale-host-only|stale-domain");
  });
});

describe("身份快照归一化", () => {
  it("正常结果原样透传", () => {
    const snapshot = normalizeIdentity(
      { ok: true, variant: "pc-latest", os: "pc", osver: "x", appver: PC_LATEST_VERSION, deviceId: DEVICE_ID },
      "off",
    );
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.variant, "pc-latest");
    assert.equal(snapshot.appver, PC_LATEST_VERSION);
    assert.equal(snapshot.note, "");
  });

  it("失败结果带上页面给的理由", () => {
    const snapshot = normalizeIdentity({ ok: false, note: "页面里没有 APP_CONF" }, "pc-clean");
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.variant, "pc-clean");
    assert.equal(snapshot.note, "页面里没有 APP_CONF");
  });

  it("拿不到结果时退回兜底，不编造字段", () => {
    for (const bad of [null, undefined, "nope", 42]) {
      const snapshot = normalizeIdentity(bad, "pc-latest");
      assert.equal(snapshot.ok, false, JSON.stringify(bad));
      assert.equal(snapshot.variant, "pc-latest", JSON.stringify(bad));
      assert.equal(snapshot.appver, "", JSON.stringify(bad));
      assert.equal(snapshot.note, "读取页面身份失败", JSON.stringify(bad));
    }
  });

  it("变体名不在已知集合里时退回调用方给的变体", () => {
    const snapshot = normalizeIdentity({ ok: true, variant: "totally-made-up", appver: "9" }, "pc-clean");
    assert.equal(snapshot.variant, "pc-clean");
  });

  it("空闲快照是不可变的基线，别被上一次的结果污染", () => {
    const first = normalizeIdentity({ ok: true, variant: "pc-latest", appver: "x" }, "off");
    assert.notEqual(first.note, IDENTITY_IDLE.note);
    assert.equal(IDENTITY_IDLE.ok, false);
    assert.equal(IDENTITY_IDLE.appver, "");
  });
});
