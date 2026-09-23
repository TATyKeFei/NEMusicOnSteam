# NEMuxicOnSteam

这是一个`Millennium`插件，可以让你的Steam运行`网易云Web版`

这个项目还在胚胎阶段，可能需要点时间完善。如果你愿意贡献代码可以提个PR

## 为什么有客户端还要去写这个？

如果你去网易云音乐官网下载页面点击Linux下载，你会发现tm居然直接跳转到Web版？

网易那么多个客户端版本就是不给Linux适配，我天天用Muxicfox按错快捷键有点烦

然后我看到我Steam天天在后台没啥用，想到他能装插件于是就萌生了这种想法让Linux用上网易云

反正Stean天天在后台吃内存也是吃白饭，不用白不用。哦对了v社啥时候才支持wayland，2027年了哥

我体验下来确实不错，没想到音质也这么好

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

装好并启用之后，Steam 主窗口左下角有一个 **网易云** 按钮（可以拖走）。也可以从 **视图** 菜单里打开，或者到 Millennium 的插件设置里点打开。

- **展开**：菜单栏下面整块都是播放器。要回去看库，先点 **收起**。
- **收起**：默认在右下角留 4 像素的画面，让页面保持“可见”，减少被 Chromium 冻住。按钮会变成「网易云 · 后台」。
- **关闭**：销毁内嵌页，后台播放也停。

设置里可以开「启动时打开」。默认不开，避免一启动 Steam 就被播放器盖住。

## 后台播放

本机这份 Steam 前端里，语音通话会调用：

`SteamClient.Browser.SetBackgroundThrottlingDisabled(true)`

插件在播放器还活着的时候，每隔几秒把同一个开关打开。这是为了 Steam 窗口最小化之后，页面里的定时器和切歌逻辑还能跑。

这是对照当前 Steam 的 `steamui` 写的，**还没有在最小化状态下实际听完一首再切歌的验证**。如果最小化之后声音还在、但播完不切下一首，多半是网页自己暂停了，或者这版 CEF 没理会这个接口。插件解决不了那种情况。收起时如果连那 4 像素也关掉，切歌更容易停。

也没有接系统媒体键和 MPRIS。音质、歌词就是网页播放器的水平，不是网易云桌面客户端。

## 依赖

- Millennium **3.4.0** 或更新。Linux 不支持 Flatpak / Snap 版 Steam。
- 构建用 Bun 1.0+，或者 Node + npm。这个仓库在没有 Bun 的环境里用 npm 编过。

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

## 视图菜单那一项

`backend/main.lua` 会在 Steam 的 `chunk~*.js` 里，给「库」菜单项前面插一个「网易云音乐」。字符串是对当前客户端核对过的。Steam 更新后菜单项可能消失，左下角按钮和插件设置还在。补丁对不上时 Millennium 会跳过，不应该把整个界面打崩。

## 已知限制

- 第一次要在内嵌页里登录。登录弹窗依赖 Steam 允许非信任弹窗（插件创建 BrowserView 时关了 `bOnlyAllowTrustedPopups`）。
- 展开时盖住主窗口内容，模态框也可能点不到，先收起。
- Steam 更新可能改掉 `BrowserView` 或主窗口名字 `SP Desktop`，那样就打不开画面。
- 不注入网易云页面内部，也改不了它的播放逻辑。
- 关闭播放器时会把那个节流开关设回去。这时候如果正在语音，有可能和通话抢同一个开关。
- Millennium 官方说法是客户端内的主题和插件不违反订阅协议。这仍然是非官方修改，风险自己担。
