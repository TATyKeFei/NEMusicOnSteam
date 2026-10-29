local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

local unloading = false
local helper_pids = {}
local helper_grace = {}

-- 宿主的 time_ms 在 32 位 Lua 下可能溢出，因此按调用次数退避。
-- 给冷启动留出余量，避免尚未写端口文件时重复启动进程争抢 D-Bus 名称。
local RESPAWN_SKIP_POLLS = { 10, 20, 40, 80, 120 }
local helpers = {
    mpris = {
        name = "mpris", entry = "helper.py", polls = 20, retry_only = true,
        assets = {
            { "backend/mpris_helper.py", "helper.py", "helper" },
            { "backend/recognition.py", "recognition.py", "recognition" },
            { "backend/audio_source.py", "audio_source.py", "audio-source" },
            { "backend/download_files.py", "download_files.py", "download-files" },
            { "backend/audio_tags.py", "audio_tags.py", "audio-tags" },
        },
    },
    mpv = {
        name = "mpv", entry = "helper.py", polls = 200,
        assets = {
            { "backend/mpv_helper.py", "helper.py", "helper" },
            { "backend/pcm_mixer.py", "pcm_mixer.py", "pcm-mixer" },
            { "backend/track_analysis.py", "track_analysis.py", "track-analysis" },
            { "backend/audio_source.py", "audio_source.py", "audio-source" },
            { "backend/playback_http.py", "playback_http.py", "playback-http" },
        },
    },
    mpd = {
        name = "mpd", entry = "helper.py", polls = 20, shutdown_grace = 1500,
        assets = {
            { "backend/mpd_helper.py", "helper.py", "helper" },
            { "backend/playback_http.py", "playback_http.py", "playback-http" },
        },
    },
    unblock = {
        name = "unblock", entry = "helper.cjs", polls = 20, fixed_skip = 10,
        interpreter = "env -u LD_LIBRARY_PATH -u LD_PRELOAD node",
        assets = { { "dist/unblock_helper.cjs", "helper.cjs", "helper" } },
    },
}

local function shell_quote(value)
    return "'" .. value:gsub("'", "'\\''") .. "'"
end

-- 辅助进程是从 Steam 后端脱离出来的，前端的异步 fetch 在 Steam 退出时不一定来得及
-- 发出 /shutdown。启动时把它们放进自己的进程组并记录组长 PID，这样 on_unload 可以同步
-- 收掉 Python、识曲录音子进程以及 mpv，避免 Steam 关掉窗口后还留在后台。
local function launch_helper(path, dir, log_path, interpreter)
    local pid_path = dir .. "/pid"
    -- exec 让 $! 就是 setsid/python 的 PID，而不是临时 shell 的 PID；只有它是
    -- 新进程组组长时，退出时的 kill -- -PID 才能连同 mpv、parec 一起回收。
    local command = "setsid " .. (interpreter or "python3") .. " " .. shell_quote(path) .. " " .. shell_quote(dir)
        .. " </dev/null >" .. shell_quote(log_path) .. " 2>&1 & helper_pid=$!; echo $helper_pid >"
        .. shell_quote(pid_path)
    utils.exec(command)
    helper_pids[dir] = utils.read_file(pid_path)
    return pid_path
end

local function stop_helper(dir)
    if dir == nil then return end
    local pid = helper_pids[dir] or utils.read_file(dir .. "/pid")
    if pid ~= nil then
        pid = pid:match("^%s*(%d+)%s*$")
        if pid ~= nil and tonumber(pid) ~= nil and tonumber(pid) > 1 then
            -- 先杀进程组，确保 mpv/parec 等子进程不会脱离；再补一次单 PID，兼容
            -- 某些系统没有 setsid 或旧实例没有建立进程组的情况。
            utils.exec("kill -TERM -- -" .. pid .. " 2>/dev/null; kill -TERM " .. pid .. " 2>/dev/null")
            utils.sleep(helper_grace[dir] or 100)
            utils.exec("kill -KILL -- -" .. pid .. " 2>/dev/null; kill -KILL " .. pid .. " 2>/dev/null")
        end
    end
    fs.remove_all(dir)
    helper_pids[dir] = nil
    helper_grace[dir] = nil
end

-- 过去任何失败都只返回 ""，前端把它一律变成「请检查 Python/PyGObject/D-Bus」，导致用户
-- 去安装他们本来就已经装好的包。改为返回 "!<code>:<detail>" 形式的失败原因，让设置页能
-- 指出到底是哪一步失败了。
local function last_log_line(path)
    local text = utils.read_file(path)
    if text == nil then return "" end
    local line = ""
    for candidate in text:gmatch("[^\r\n]+") do
        line = candidate
    end
    line = line:gsub("|", "/"):gsub("%s+$", "")
    if #line > 200 then line = line:sub(-200) end
    return line
end

local function reset_helper(helper)
    stop_helper(helper.dir)
    helper.dir = nil
    helper.token = nil
    helper.failures = 0
    helper.skip = 0
    helper.failure = "!retry"
end

local function helper_endpoint(helper)
    if unloading then return "!shutdown" end
    local function ready_endpoint()
        if helper.dir == nil then return nil end
        local port = utils.read_file(helper.dir .. "/port")
        if port == nil or not port:match("^%d+$") then return nil end
        helper.failures = 0
        helper.skip = 0
        helper.failure = "!retry"
        return "http://127.0.0.1:" .. port .. "|" .. helper.token
    end
    local endpoint = ready_endpoint()
    if endpoint ~= nil then return endpoint end
    if (helper.skip or 0) > 0 then
        helper.skip = helper.skip - 1
        return helper.retry_only and "!retry" or helper.failure
    end
    stop_helper(helper.dir)
    helper.dir = nil
    helper.token = nil
    helper.failures = (helper.failures or 0) + 1
    helper.skip = helper.fixed_skip or RESPAWN_SKIP_POLLS[math.min(helper.failures, #RESPAWN_SKIP_POLLS)]
    local function failure(reason, cleanup)
        helper.failure = reason
        if cleanup then
            stop_helper(helper.dir)
            helper.dir = nil
            helper.token = nil
        end
        return reason
    end
    local assets = {}
    for _, asset in ipairs(helper.assets) do
        local content = millennium.assets.read(asset[1])
        if content == nil then return failure("!asset-" .. asset[3]) end
        table.insert(assets, { asset[2], content, asset[3] })
    end
    local base = utils.getenv("XDG_RUNTIME_DIR") or "/tmp"
    local dir = base .. "/nemusic-" .. helper.name .. "-" .. utils.uuid()
    if not fs.create_directories(dir) then return failure("!mkdir:" .. base) end
    helper.dir = dir
    helper_grace[dir] = helper.shutdown_grace
    helper.token = utils.uuid()
    utils.exec("chmod 700 " .. shell_quote(dir))
    for _, asset in ipairs(assets) do
        if not utils.write_file(dir .. "/" .. asset[1], asset[2]) then
            return failure("!write-" .. asset[3], true)
        end
    end
    if not utils.write_file(dir .. "/token", helper.token) then return failure("!write-token", true) end
    -- 日志留在运行目录外，进程启动失败清理目录时仍能读取错误。
    local log_path = base .. "/nemusic-" .. helper.name .. ".log"
    launch_helper(dir .. "/" .. helper.entry, dir, log_path, helper.interpreter)
    for _ = 1, helper.polls do
        endpoint = ready_endpoint()
        if endpoint ~= nil then
            fs.remove(log_path)
            return endpoint
        end
        utils.sleep(50)
    end
    local detail = last_log_line(log_path)
    return failure(detail == "" and "!spawn" or "!spawn:" .. detail)
end

---@ffi
---@return string
function mpris_endpoint()
    return helper_endpoint(helpers.mpris)
end

---@ffi
---@return string
function mpris_reconnect()
    if unloading then return "!shutdown" end
    reset_helper(helpers.mpris)
    return mpris_endpoint()
end

---@ffi
---@return string
function mpv_endpoint()
    return helper_endpoint(helpers.mpv)
end

---@ffi
---@return string
function mpd_endpoint()
    return helper_endpoint(helpers.mpd)
end

---@ffi
---@return string
function unblock_stop()
    reset_helper(helpers.unblock)
    return "ok"
end

---@ffi
---@return string
function unblock_endpoint()
    return helper_endpoint(helpers.unblock)
end

---@ffi
---@return string
function diagnostics()
    -- 只返回固定依赖的可用性；不返回环境变量、目录、登录态或辅助进程令牌。
    local script = [[for tool in python3 mpv ffmpeg node; do if command -v "$tool" >/dev/null 2>&1; then echo "$tool=ok"; else echo "$tool=missing"; fi; done
python3 -c 'from gi.repository import Gio, GLib' >/dev/null 2>&1 && echo 'PyGObject=ok' || echo 'PyGObject=missing'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 && echo 'Node22=ok' || echo 'Node22=missing'
test -n "$DBUS_SESSION_BUS_ADDRESS" && echo 'sessionBus=ok' || echo 'sessionBus=missing']]
    local ok, pipe = pcall(io.popen, "env -u LD_LIBRARY_PATH -u LD_PRELOAD sh -c " .. shell_quote(script), "r")
    if not ok or pipe == nil then return "environment=unavailable" end
    local read_ok, result = pcall(pipe.read, pipe, "*a")
    pcall(pipe.close, pipe)
    if not read_ok or type(result) ~= "string" or result == "" then return "environment=unavailable" end
    return "Millennium=" .. tostring(millennium.version()) .. "\n" .. result
end

local function on_load()
    logger:info("NEMusicOnSteam loaded with Millennium " .. tostring(millennium.version()))
    millennium.ready()
end

local function on_frontend_loaded()
    logger:info("Steam UI is up. Open NetEase from the library footer, the View menu, or plugin settings.")
end

local function on_unload()
    if unloading then return end
    unloading = true
    logger:info("NEMusicOnSteam unloading")
    -- 先收掉脱离 Steam 生命周期的辅助进程；前端的清理随后即使来不及完成也不会
    -- 把 Steam 留在后台。
    reset_helper(helpers.mpris)
    reset_helper(helpers.mpv)
    reset_helper(helpers.mpd)
    reset_helper(helpers.unblock)
    -- Steam 退出期间同步等 WebKit 返回会造成后端和前端相互等候。辅助进程已在上面
    -- 回收；视图和前端计时器由 Steam 自己的销毁流程处理，因此这里绝不跨进程等待。
end

---@ffi
---@return string
function shutdown_backend()
    on_unload()
    return "ok"
end

return {
    on_load = on_load,
    on_frontend_loaded = on_frontend_loaded,
    on_unload = on_unload,
    patches = {
        {
            find = [[return Ga\},\[Kr,Ua\]\)]],
            file = [[chunk~[0-9a-f]+\.js]],
            transforms = {
                {
                    match = [[return Ga\},\[Kr,Ua\]\)]],
                    replace = [=[Ga.push({visible:!0,title:String.fromCharCode(0x7f51,0x6613,0x4e91,0x97f3,0x4e50),icon:(0,e.jsx)(function NEMusicSettingsIcon(){try{var plugin=#{{self}};return plugin&&plugin.renderSettingsIcon?plugin.renderSettingsIcon():null}catch(error){console.error("[NEMusic] settings icon",error);return null}},{}),route:r.BV.Settings.Music().replace(/music$/,"nemusic"),content:(0,e.jsx)(function NEMusicSettings(){try{var plugin=#{{self}};return plugin&&plugin.renderSettings?plugin.renderSettings():null}catch(error){console.error("[NEMusic] settings",error);return null}},{})});return Ga},[Kr,Ua])]=],
                },
            },
        },
        {
            find = [[\{name:"#Menu_Library",steamURL:"steam://open/library/view/home"\}]],
            file = [[chunk~[0-9a-f]+\.js]],
            -- 菜单标签保持 ASCII：打包后的 Lua 会破坏原始非 ASCII 字符，否则「查看」菜单里会显示乱码。
            transforms = {
                {
                    match = [[\{name:"#Menu_Library",steamURL:"steam://open/library/view/home"\}]],
                    replace = [[{name:"\u7f51\u6613\u4e91\u97f3\u4e50",onClick:function(){try{var plugin=#{{self}};if(plugin&&plugin.openPlayer)plugin.openPlayer()}catch(e){console.error("[NEMusic]",e)}}},{name:"#Menu_Library",steamURL:"steam://open/library/view/home"}]],
                },
            },
        },
    },
}
