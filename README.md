# NEMuxicOnSteam

这是一个`Millennium`插件，可以让你的Steam运行`网易云Web版`

注意! 使用的是官网那个页面，不是重写的客户端：`https://music.163.com/st/webplayer`

把网易云官方网页播放器嵌进 **Steam 主窗口**，就不用再挂一个浏览器和他们的客户端吃你内存了

这个项目还在胚胎阶段，先把框架搭起来再完善UI和使用体验这类，需要点时间

如果你愿意贡献代码可以提个Issues让我知道再提PR

# 声明

非任何官方插件! 本项目与网易、Valve 都没关系。我要有关系我还写这个sb项目

登录态在 Steam 自带的浏览器里，和系统浏览器不共享

# 支持

| 系统    | 可用性                 | 备注       |
| :---    | :---                   | :---       |
| Linux   | 支持x86_64             | 由于Millennium仅支持x86_64版本的Steam不支持arm，我也无能为力                           |
| Windows | 未知                   | 我不用Windows，对于Win的支持完全不保证。如果你有需求且愿意维护测试可以自己fork一份     |
| FreeBSD | 未测试                 | Linux可以的话也许FreeBSD理论也可以                                                     |
| Mac OS  | 不支持                 | 我是穷鬼安卓人没钱买苹果测试，不过Millennium好像也没支持MacOS                          |

# 特色功能

| 内容       | 支持状况                                              | 备注   |
| :---       | :---                                                  | :---   |
| MPRIS      | 支持媒体键、控制音量进度条; 循环、列表播放还未支持  |  |
| 通知       | 支持发送系统通知显示歌曲信息、封面                    | Mako、Windows未测试，仅测试了KDE通知        |
| 音质设置   | 支持           | 在**Steam → 设置 → 网易云音乐**里可以设置。但要注意账号是否有vip不然开不了高音质 |
| 后台播放   | 支持  | 依赖Steam的通话api，如果你正在使用通话功能可能导致中断。不过应该没人边打电话变听歌吧?       |
| 游戏中叠加页面 | 正在尝试支持 | 仅支持X11的游戏/软件，因为傻逼Steam不支持Wayland |
| 状态显示当前歌曲 | 考虑支持中 | 让好友能看到你在听啥歌 |
|  |

# 安装

## 注意事项

- 需要 Millennium **3.4.0+**
- 不支持通过 Flatpak / Snap 安装的 Steam

### Arch系

#### 通过Pacman安装(推荐)

如果配置过archlinuxcn仓库，Millennium在archlinuxcn上有，你可以从archlinuxcn仓库安装

没配置过archlinuxcn仓库的人也强烈建议去弄下老好用了

```
sudo pacman -S millennium
```

#### 通过Aur安装

没配置过archlinuxcn可以通过Aur安装

```
paru: `paru -S millennium`
yay: `yay -S millennium`
```

### Windows

不知道，好像是通过exe安装包安装的。可以看看Millennium官网

https://docs.steambrew.app/users/getting-started/installation

### 其他发行版/系统

其他发行版的预编译脚本，官方推荐的我没试过，装之前建议自己先看一遍

```bash
curl -fsSL "https://steambrew.app/install.sh" | bash
```

## 安装插件

从[Releases](https://github.com/TATyKeFei/NEMusicOnSteam/releases)页面下载最新版插件，放入这个路径里

Linux: `~/.local/share/millennium/plugins/`

Windows: `不知道`

然后完全终止 Steam 进程再打开，在 **Steam → Millennium → Plugins**

## 为什么有客户端还要去写这个？

如果你去网易云音乐官网下载页面点击Linux下载，你会发现tm居然直接跳转到Web版？

网易那么多个客户端版本就是不给Linux适配，我天天用Muxicfox按错快捷键有点烦

然后我看到我Steam天天在后台没啥用，想到他能装插件于是就萌生了这种想法让Linux用上网易云

反正Stean天天在后台吃内存也是吃白饭，不用白不用。哦对了v社啥时候才支持wayland，2027年了哥

我体验下来确实不错，没想到Web版音质也这么好

# 怎么用?

装好并启用之后，「库」「社区」那一行的右侧有一个 **网易云** 文字链接。也可以从 **视图** 菜单里打开，或者到 Millennium 的插件设置里点打开。

- **打开**：顶部的「网易云」切换到播放器页面。鼠标移上「网易云」会出现与「库」「社区」相同的 Steam 原生菜单，可收起、刷新或关闭；点击其他栏目会返回 Steam 页面。
- **收起**：默认在右下角留 4 像素的画面，让页面保持“可见”，减少被 Chromium 冻住。再点「网易云」会重新打开播放器页面。
- **关闭**：销毁内嵌页，后台播放也停。

设置里可以开「启动时打开」。默认不开，避免一启动 Steam 就被播放器盖住。

# 功能

## 后台播放

Steam 语音通话会调用`SteamClient.Browser.SetBackgroundThrottlingDisabled(true)`

插件在播放器还活着的时候，每隔几秒把同一个开关打开。这是为了 Steam 窗口最小化之后，页面里的定时器和切歌逻辑还能跑。

这是对照当前 Steam 的 `steamui` 写的，**还没有在最小化状态下实际听完一首再切歌的验证**。如果最小化之后声音还在、但播完不切下一首，多半是网页自己暂停了，或者 CEF 没理会这个接口。插件解决不了那种情况。收起时如果连那 4 像素也关掉，切歌更容易停。

## MPRIS

> 需要 Python3、PyGObject和D-Bus

Arch系可以安装这个解决`sudo pacman -S python-gobject`、Debian系安装`python3-gi`、Windows不知道

MPRIS 使用 Millennium 的 Chrome DevTools 接口读取内嵌网页，再由随插件打包的 Python 辅助进程在用户会话 D-Bus 上注册 `org.mpris.MediaPlayer2.NEMusicOnSteam`。打开 Steam 后可用 `playerctl -l` 查看；关闭 Steam 或卸载插件后，辅助进程会在约 15 秒内自行退出。网页改版可能使歌曲信息或上一首、下一首按钮失效

播放一首歌后可以用 `playerctl -p NEMusicOnSteam metadata` 查看信息，或用 `playerctl -p NEMusicOnSteam play-pause` 测试控制。插件设置页会显示 MPRIS 连接状态

Linux 上首次开始播放或切换歌曲后开始播放时，会发送系统桌面通知：标题为当前歌名，正文为歌手，图标优先显示歌曲封面。封面在后台加载并临时缓存，加载失败时使用默认音乐图标。同一首歌暂停后继续播放、持续播放、调整进度和音量不会重复通知；通知遵循桌面系统的勿扰设置，默认显示约 5 秒

进度跳转和音量控制通过网页现有的 Redux 播放器动作执行，音量读取播放器确认后的状态，关闭音量浮层也能操作。可以用 `playerctl -p NEMusicOnSteam position 60` 跳到第 60 秒，用 `playerctl -p NEMusicOnSteam volume 0.3` 调到 30%，再用 `playerctl -p NEMusicOnSteam volume` 查看回报。如果网页改版后无法找到播放器状态，插件设置页和 Steam 控制台会报告命令未执行

# 构建

```bash
npm install
npm test
npm run build
```

构建产物在 `dist/com.nemusic.onsteam.star`

```安装
cp ./dist/com.nemusic.onsteam.star ~/.local/share/millennium/plugins/
```

Millennium 已经装好的话，可以把 `millennium.toml` 里的 `output_path` 改成 `auto` 再构建一次，starlight 会自己放进插件目录。

开发时：

```bash
npm run dev
```

# 已知限制

- 第一次要在内嵌页里登录。登录弹窗依赖 Steam 允许非信任弹窗（插件创建 BrowserView 时关了 `bOnlyAllowTrustedPopups`）
- 播放器页面使用 Steam 的 BrowserView 承载网页；Steam 本身没有供插件注册独立主窗口路由的稳定接口
- Steam 更新可能改掉 `BrowserView` 或主窗口名字 `SP Desktop`可能导致打不开，需要时间适配
- MPRIS 通过 DevTools 在网易云页面读取状态并调用现有播放器动作，依赖网页的 React/Redux 结构；网易云音乐Web版改版可能需要更新适配
- 关闭播放器时会把那个节流开关设回去。这时候如果正在语音，有可能和通话抢同一个开关

## Ai声明

我不会typescript和lua，我臭玩rust和godotscript的。这个项目是我指挥Ai写的

Grok4.7是真笨啊，还是gpt6好使

反正这个项目也不大就内嵌个页面支持点小玩意没啥技术含量

# 参考的项目

非常感谢以下项目，本项目部分功能参考或使用了他们的思路

| 项目 | 链接 |
| :--- | :--- |
| MusicFox | [Github仓库](https://github.com/go-musicfox/go-musicfox) |