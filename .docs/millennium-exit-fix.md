# Linux 退出后仍有 Steam 进程

本机 Millennium 3.5.0 在 Steam 退出时会先销毁 `millennium_lifecycle` 的条件变量，再执行引导库注册的清理回调。仍在等待条件变量的线程使 `pthread_cond_destroy` 卡住，Lua 后端也因此无法正常卸载。等待期间 Steam 的音频线程还可能崩溃。

插件在收到 Steam 的关闭通知时提前停止计时器、销毁音乐视图并清理辅助进程，也阻止待完成的打开操作重新创建视图。但这个框架问题需要同时修复 Millennium，仅更新 `.star` 无法修复主进程的死锁。

`patches/millennium-3.5.0-exit.patch` 使生命周期同步对象和退出期间仍需使用的事件记录对象保持到进程结束，由操作系统回收。事件对象提前销毁也会使后续移除监听器重复释放内存。这些改法与上游 [PR #841](https://github.com/SteamClientHomebrew/Millennium/pull/841) 中的对象生命周期修复一致。补丁应用到官方 `v3.5.0` 源码后重新构建，不改变插件接口。

## 回归验证

使用 Millennium 源码的头文件编译测试：

```sh
g++ -std=c++23 -pthread -I/tmp/Millennium-3.5.0/src/include tests/millennium-lifecycle-exit.cc -o /tmp/millennium-lifecycle-exit-test
timeout 3 /tmp/millennium-lifecycle-exit-test
```

原版会卡住并返回超时码 `124`；应用补丁后正常返回 `0`。实机打开网易云官方音乐页后正常退出 Steam，修复版约 6 秒内结束 Steam、steamwebhelper、Lua 后端及 MPRIS 辅助进程，没有产生新的崩溃转储。

监听器清理测试可使用 AddressSanitizer 验证：

```sh
g++ -std=c++23 -pthread -fsanitize=address -g -I/tmp/Millennium-3.5.0/src/include -I/tmp/nemos-millennium-build/_deps/nlohmann_json-src/include tests/millennium-crash-listener-exit.cc /tmp/Millennium-3.5.0/src/mep/crash_event_bus.cc -o /tmp/millennium-crash-listener-exit-test
ASAN_OPTIONS=detect_leaks=0 /tmp/millennium-crash-listener-exit-test
```

原版会报告移除监听器时访问已释放内存；应用补丁后正常返回 `0`。

## 本机安装和恢复

本机修复运行库存放在 `~/.local/share/millennium/exit-fix-3.5.0/`，Steam 的 `ubuntu12_32/libXtst.so.6` 引导链接指向该目录。`/usr/lib/millennium/` 中的系统安装保留。这个本地运行库按当前机器的依赖构建；其他机器建议在对应环境重新编译。

恢复系统原版前先退出 Steam，再执行：

```sh
ln -sfn /usr/lib/millennium/libmillennium_bootstrap_x86.so ~/.local/share/Steam/ubuntu12_32/libXtst.so.6
```

Millennium 系统包更新可能会重新设置这个链接。更新到含有上游修复的版本后，应恢复系统引导链接，避免继续固定使用 3.5.0。
