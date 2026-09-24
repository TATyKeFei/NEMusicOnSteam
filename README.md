# NEMuxicOnSteam

这是一个`Millennium`插件，可以让你的Steam运行`网易云Web版`

这个项目还在胚胎阶段，可能需要点时间完善。如果你愿意贡献代码可以提个PR

# 支持

| 系统    | 可用                   | 备注       |
| :---    | :---                   | :---       |
| Linux   | 仅支持x86_64版本Steam  | 由于Millennium仅支持x86_64版本的Steam不支持arm，我也无能为力                   |
| Windows | 未知                   | 我不用Windows了，对于Win的支持完全不保证。如果你愿意维护测试可以自己fork一份   |
| FreeBSD | 未测试                 | 也许理论可以                                                                   |
| Mac OS  | 未测试                 | 我是穷鬼安卓人没钱买苹果测试                                                   |

## 为什么有客户端还要去写这个？

如果你去网易云音乐官网下载页面点击Linux下载，你会发现tm居然直接跳转到Web版？

网易那么多个客户端版本就是不给Linux适配，我天天用Muxicfox按错快捷键有点烦

然后我看到我Steam天天在后台没啥用，想到他能装插件于是就萌生了这种想法让Linux用上网易云

反正Stean天天在后台吃内存也是吃白饭，不用白不用。哦对了v社啥时候才支持wayland，2027年了哥

我体验下来确实不错，没想到Web版音质也这么好

## Ai声明

我不会typescript和lua，我臭玩rust和godotscript的。这个项目是我指挥Ai写的

Grok4.7是真笨啊，还是gpt6好使

反正这个项目也不大就内嵌个页面没啥技术含量

---

# 以下是ai写的不是我写的

# 网易云音乐 · Steam 内嵌

把网易云官方网页播放器嵌进 **Steam 主窗口**，不用再挂一个 Electron 或浏览器。

播放的是官网那个页面，不是重写的客户端：

`https://music.163.com/st/webplayer`

这是非官方插件，和网易、Valve 都没关系。登录态在 Steam 自带的浏览器里，和系统 Chrome 不共享。

## 怎么用

装好并启用之后，「库」「社区」那一行的右侧有一个 **网易云** 文字链接。也可以从 **视图** 菜单里打开，或者到 Millennium 的插件设置里点打开。

- **打开**：顶部的「网易云」切换到播放器页面。鼠标移上「网易云」会出现与「库」「社区」相同的 Steam 原生菜单，可收起、刷新或关闭；点击其他栏目会返回 Steam 页面。
- **收起**：默认在右下角留 4 像素的画面，让页面保持“可见”，减少被 Chromium 冻住。再点「网易云」会重新打开播放器页面。
- **关闭**：销毁内嵌页，后台播放也停。

设置里可以开「启动时打开」。默认不开，避免一启动 Steam 就被播放器盖住。

## 音质设置

打开 **Steam → 设置 → 网易云音乐**，在「播放音质」中选择标准、较高、极高、无损、Hi-Res、高清臻音、超清母带或沉浸环绕声。Millennium 的「网易云音乐」插件设置里也有同样的选项。需要先打开网易云播放器，设置页才会读取音质。

设置会保存在网易云网页播放器中。正在播放在线歌曲时，切换音质会重新加载当前歌曲并保留播放进度，期间可能短暂停顿；暂停、加载中、本地文件和播客只保存偏好，下一首歌曲生效，不会主动开始播放。

「播放音质」是偏好，「当前实际音质」读取网易云播放器确认的结果。实际可用音质取决于登录账号的会员权益、歌曲资源和网页支持，网易云可能返回较低档位。未登录时只能选择最高 320 kbps。

## 后台播放

本机这份 Steam 前端里，语音通话会调用：

`SteamClient.Browser.SetBackgroundThrottlingDisabled(true)`

插件在播放器还活着的时候，每隔几秒把同一个开关打开。这是为了 Steam 窗口最小化之后，页面里的定时器和切歌逻辑还能跑。

这是对照当前 Steam 的 `steamui` 写的，**还没有在最小化状态下实际听完一首再切歌的验证**。如果最小化之后声音还在、但播完不切下一首，多半是网页自己暂停了，或者这版 CEF 没理会这个接口。插件解决不了那种情况。收起时如果连那 4 像素也关掉，切歌更容易停。

Linux 上接入了 MPRIS：桌面媒体控件可以显示歌曲信息，并发送播放、暂停、上一首、下一首和进度跳转命令。音质、歌词仍然是网页播放器的水平，不是网易云桌面客户端。

MPRIS 使用 Millennium 的 Chrome DevTools 接口读取内嵌网页，再由随插件打包的 Python 辅助进程在用户会话 D-Bus 上注册 `org.mpris.MediaPlayer2.NEMusicOnSteam`。打开 Steam 后可用 `playerctl -l` 查看；关闭 Steam 或卸载插件后，辅助进程会在约 15 秒内自行退出。网页改版可能使歌曲信息或上一首、下一首按钮失效。

播放一首歌后可以用 `playerctl -p NEMusicOnSteam metadata` 查看信息，或用 `playerctl -p NEMusicOnSteam play-pause` 测试控制。插件设置页会显示 MPRIS 连接状态。

Linux 上首次开始播放或切换歌曲后开始播放时，会发送系统桌面通知：标题为当前歌名，正文为歌手，图标优先显示歌曲封面。封面在后台加载并临时缓存，加载失败时使用默认音乐图标。同一首歌暂停后继续播放、持续播放、调整进度和音量不会重复通知；通知遵循桌面系统的勿扰设置，默认显示约 5 秒。


进度跳转和音量控制通过网页现有的 Redux 播放器动作执行，音量读取播放器确认后的状态，关闭音量浮层也能操作。可以用 `playerctl -p NEMusicOnSteam position 60` 跳到第 60 秒，用 `playerctl -p NEMusicOnSteam volume 0.3` 调到 30%，再用 `playerctl -p NEMusicOnSteam volume` 查看回报。如果网页改版后无法找到播放器状态，插件设置页和 Steam 控制台会报告命令未执行。

## 依赖

- Millennium **3.4.0** 或更新。Linux 不支持 Flatpak / Snap 版 Steam。
- 构建用 Bun 1.0+，或者 Node + npm。这个仓库在没有 Bun 的环境里用 npm 编过。
- Linux MPRIS 需要系统的 Python 3、PyGObject 和用户会话 D-Bus。Arch 安装 `python-gobject`；Debian/Ubuntu 安装 `python3-gi`。

安装 Millennium（其他发行版的预编译脚本，装之前自己看一遍）：

```bash
curl -fsSL "https://steambrew.app/install.sh" | bash
```

Arch 可以用 AUR 的 `millennium`。装好后完全退出 Steam 再开。

## 构建

```bash
npm install
npm test
npm run build
```

构建产物是单个文件 `dist/com.nemusic.onsteam.star`，不是目录。复制到 Millennium 的插件目录：

```bash
mkdir -p ~/.local/share/millennium/plugins
cp dist/com.nemusic.onsteam.star ~/.local/share/millennium/plugins/
```

然后完全退出 Steam 再打开，在 **Steam → Millennium → Plugins** 里启用「网易云音乐」。

Millennium 已经装好的话，可以把 `millennium.toml` 里的 `output_path` 改成 `auto` 再构建一次，starlight 会自己放进插件目录。

开发时：

```bash
npm run dev
```

## 顶部链接和视图菜单

`backend/main.lua` 会改 Steam 当前这份 `chunk~*.js`，两处都是按本机客户端对过的：

- 「库」「社区」那一行末尾加一个真正的「网易云」栏目，用 Steam 同一个 `SuperNav` 菜单组件承载标题和悬浮菜单，再用 `margin-left: auto` 推到右侧。
- 「视图」菜单里，在「库」前面加一项「网易云音乐」。
- Steam 设置侧栏添加「网易云音乐」，可调节播放音质并查看当前实际音质。

设置入口还有运行时挂载方式：如果启动时的脚本补丁未显示入口，插件会在 Steam 设置窗口出现后补上。关闭设置窗口或卸载插件时会清理入口；点击其他设置项会恢复 Steam 原页面。

补丁对不上时 Millennium 会跳过，不应该把整个界面打崩。顶部如果没打上，插件还会试着把文字链接插进同一行；再不行，视图菜单和插件设置里的打开还在。

改完要完全退出 Steam 再开。只关窗口的话，旧界面还在，顶部链接不会出现。

## 已知限制

- 第一次要在内嵌页里登录。登录弹窗依赖 Steam 允许非信任弹窗（插件创建 BrowserView 时关了 `bOnlyAllowTrustedPopups`）。
- 播放器页面使用 Steam 的 BrowserView 承载网页；Steam 本身没有供插件注册独立主窗口路由的稳定接口。
- Steam 更新可能改掉 `BrowserView` 或主窗口名字 `SP Desktop`，那样就打不开画面。
- MPRIS 通过 DevTools 在网易云页面读取状态并调用现有播放器动作，依赖网页的 React/Redux 结构；网页改版可能需要更新适配。
- 关闭播放器时会把那个节流开关设回去。这时候如果正在语音，有可能和通话抢同一个开关。
- Millennium 官方说法是客户端内的主题和插件不违反订阅协议。这仍然是非官方修改，风险自己担。
