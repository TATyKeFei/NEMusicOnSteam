# 这个是临时修复millennium退出进程残留bug用的，不知道什么时候修复恶心死人了。所以ai生成的文本我懒得改了

# Linux 退出后仍有 Steam 进程

本机已确认 Millennium **3.5.0 和 3.6.1** 都存在这个问题：Steam 退出时会先销毁 `millennium_lifecycle` 的条件变量，再执行引导库注册的清理回调。仍在等待条件变量的线程使 `pthread_cond_destroy` 卡住，Lua 后端也因此无法正常卸载。等待期间 Steam 的音频线程还可能崩溃。

2026-10-16 升级后的检查中，Steam 已记录 `Shutdown`、所有 `steamwebhelper` 已结束，但 Steam 主进程和 `libmillennium_luavm_x86` 仍在运行；本插件的音乐辅助进程已经结束。系统更新把 `ubuntu12_32/libXtst.so.6` 重新指向了 `/usr/lib/millennium/libmillennium_bootstrap_x86.so`，因此此前本地安装的 3.5.0 修复库不再生效。仅看到版本升级到 3.6.1，不能认为退出问题已经修复。

插件在收到 Steam 的关闭通知时提前停止计时器、销毁音乐视图并清理辅助进程，也阻止待完成的打开操作重新创建视图。但这个框架问题需要同时修复 Millennium，仅更新 `.star` 无法修复主进程的死锁。

[`patches/millennium-3.5.0-exit.patch`](../patches/millennium-3.5.0-exit.patch) 使生命周期同步对象和退出期间仍需使用的事件记录对象保持到进程结束，由操作系统回收。事件对象提前销毁也会使后续移除监听器访问已释放的内存。这些改法与上游 [PR #841](https://github.com/SteamClientHomebrew/Millennium/pull/841) 中的对象生命周期修复一致。补丁文件名沿用最初修复的版本；已验证它能原样应用到官方 `v3.6.1`，无需降级，不改变插件接口。

## 构建 3.6.1 修复版

在官方 `v3.6.1` 源码目录中应用补丁，再按上游 Linux 构建要求准备编译器、32 位依赖、Bun 和 Rust：

```sh
patch -p1 < /path/to/NEMusicOnSteam/patches/millennium-3.5.0-exit.patch
cmake --preset linux-release -DMILLENNIUM_BUILD_TESTS=OFF -DMILLENNIUM_BUILD_TO_STEAM_PATH=OFF
cmake --build build --parallel 6
```

本机将运行库安装到 `~/.local/share/millennium/exit-fix-3.6.1/`，保留 `/usr/lib/millennium/` 中的系统版本。该目录包含主库、Lua 宿主、两个引导库、64 位网页钩子和 `libmillennium_pvs64`。本地 32 位引导库通过编译选项 `MILLENNIUM_RUNTIME_PATH` 指向同目录的 `libmillennium_x86.so`，然后让 Steam 的 `ubuntu12_32/libXtst.so.6` 链接到这个引导库。只复制原版引导库再改链接仍会加载 `/usr/lib` 中的原版主库。

## 回归验证

使用 Millennium 源码的头文件编译测试。以下命令按本机源码路径使用 Steam 对应的 32 位架构：

```sh
g++ -m32 -std=c++23 -pthread -I/tmp/Millennium-3.6.1/src/include tests/millennium-lifecycle-exit.cc -o /tmp/millennium-lifecycle-exit-test
timeout 3 /tmp/millennium-lifecycle-exit-test
```

原版会卡住并返回超时码 `124`；应用补丁后正常返回 `0`。3.5.0 的实机验证中，打开网易云官方音乐页后正常退出 Steam，修复版约 6 秒内结束 Steam、steamwebhelper、Lua 后端及 MPRIS 辅助进程，没有产生新的崩溃转储。

监听器清理测试可使用 AddressSanitizer 验证：

```sh
g++ -m32 -std=c++23 -pthread -fsanitize=address -g -I/tmp/Millennium-3.6.1/src/include -I/tmp/nemusic-millennium-3.6.1-build/_deps/nlohmann_json-src/include tests/millennium-crash-listener-exit.cc /tmp/Millennium-3.6.1/src/mep/crash_event_bus.cc -o /tmp/millennium-crash-listener-exit-test
ASAN_OPTIONS=detect_leaks=0 /tmp/millennium-crash-listener-exit-test
```

原版会报告移除监听器时访问已释放内存；应用补丁后正常返回 `0`。

2026-10-16 的 3.6.1 验证结果：补丁后的两个 32 位测试均返回 `0`；实机日志确认加载了 `exit-fix-3.6.1/libmillennium_x86.so`，网易云插件前后端成功加载。执行 `steam -shutdown` 后 **5.74 秒**内 Steam、所有 steamwebhelper 和 Lua 宿主全部结束，日志记录 `Millennium unloaded successfully.`，没有残留进程。本次实机验证未打开音乐页，音乐辅助进程的播放场景沿用上面的 3.5.0 验证记录。

## 本机安装和恢复

本机当前修复运行库存放在 `~/.local/share/millennium/exit-fix-3.6.1/`，Steam 的 `ubuntu12_32/libXtst.so.6` 引导链接指向该目录。原引导目标记录在该目录的 `original-bootstrap.txt` 中。3.5.0 修复目录也保留，但不再加载。这个本地运行库按当前机器的依赖构建；其他机器应在对应环境重新编译。

恢复系统原版前先退出 Steam，再执行：

```sh
ln -sfn /usr/lib/millennium/libmillennium_bootstrap_x86.so ~/.local/share/Steam/ubuntu12_32/libXtst.so.6
```

Millennium 系统包更新可能会重新设置这个链接。每次更新后应检查实际加载的运行库；升级到其他版本时，需要先验证上游是否修复此问题，或针对新版本重新应用补丁和构建，避免长期固定使用旧版运行库。确认上游已修复并通过上述测试后，再恢复系统引导链接。
