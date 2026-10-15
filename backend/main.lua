local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

local mpris_dir = nil
local mpris_token = nil
local mpv_dir = nil
local mpv_token = nil
local unblock_dir = nil
local unblock_token = nil
local unblock_skip = 0
local unblock_failure = "!retry"
local unloading = false
local helper_pids = {}

-- 前端每 500ms 轮询一次，而每次尝试拉起辅助进程都会 fork 一个 python3，并在它启动
-- 期间阻塞本进程最长一秒。没有喘息间隔的话，一个根本起不来的辅助进程会把这些阻塞连
-- 续叠加。所以这里用「跳过的轮询次数」计数，而不是去读时钟：utils.time_ms() 在这个
-- 32 位 Lua 宿主里会返回负数，早期基于截止时间的判断把它的 0 哨兵值当成「还在未来」，
-- 于是 mpris_endpoint 永远返回 "" 再也不重试。
-- 首个间隔取 5s：PyGObject 冷启动经常超过下面 1s 的端口等待，在第一个还在启动时再 fork
-- 一个，会留下两个进程抢同一个 D-Bus 名字——抢输的那个仍在提供 MPRIS 客户端根本看不到
-- 的 HTTP 服务。
local RESPAWN_SKIP_POLLS = { 10, 20, 40, 80, 120 }
local respawn_failures = 0
local respawn_skip = 0
local mpv_respawn_failures = 0
local mpv_respawn_skip = 0
local mpv_last_failure = "!retry"

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
            utils.sleep(100)
            utils.exec("kill -KILL -- -" .. pid .. " 2>/dev/null; kill -KILL " .. pid .. " 2>/dev/null")
        end
    end
    fs.remove_all(dir)
    helper_pids[dir] = nil
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

---@ffi
---@return string
function mpris_endpoint()
    if unloading then return "!shutdown" end
    if mpris_dir ~= nil then
        local port = utils.read_file(mpris_dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            respawn_failures = 0
            respawn_skip = 0
            return "http://127.0.0.1:" .. port .. "|" .. mpris_token
        end
    end
    if respawn_skip > 0 then
        respawn_skip = respawn_skip - 1
        return "!retry"
    end
    stop_helper(mpris_dir)
    mpris_dir = nil
    mpris_token = nil
    respawn_failures = respawn_failures + 1
    respawn_skip = RESPAWN_SKIP_POLLS[math.min(respawn_failures, #RESPAWN_SKIP_POLLS)]
    local script = millennium.assets.read("backend/mpris_helper.py")
    if script == nil then return "!asset-helper" end
    local recognition = millennium.assets.read("backend/recognition.py")
    if recognition == nil then return "!asset-recognition" end
    local base = utils.getenv("XDG_RUNTIME_DIR") or "/tmp"
    local dir = base .. "/nemusic-mpris-" .. utils.uuid()
    local token = utils.uuid()
    if not fs.create_directories(dir) then return "!mkdir:" .. base end
    utils.exec("chmod 700 " .. shell_quote(dir))
    local path = dir .. "/helper.py"
    if not utils.write_file(path, script) then return "!write-helper" end
    if not utils.write_file(dir .. "/recognition.py", recognition) then return "!write-recognition" end
    local audio_source = millennium.assets.read("backend/audio_source.py")
    if audio_source == nil or not utils.write_file(dir .. "/audio_source.py", audio_source) then return "!write-audio-source" end
    if not utils.write_file(dir .. "/token", token) then return "!write-token" end
    -- 日志要放在运行目录之外：辅助进程退出时会清空该目录，一个在报出端口前就死掉的
    -- 辅助进程会把自己的回溯一起带走。
    local log_path = base .. "/nemusic-mpris.log"
    mpris_dir = dir
    mpris_token = token
    launch_helper(path, dir, log_path)
    for _ = 1, 20 do
        local port = utils.read_file(dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            mpris_dir = dir
            mpris_token = token
            respawn_failures = 0
            respawn_skip = 0
            fs.remove(log_path)
            return "http://127.0.0.1:" .. port .. "|" .. token
        end
        utils.sleep(50)
    end
    local detail = last_log_line(log_path)
    if detail == "" then return "!spawn" end
    return "!spawn:" .. detail
end

---@ffi
---@return string
function mpris_reconnect()
    if unloading then return "!shutdown" end
    stop_helper(mpris_dir)
    mpris_dir = nil
    mpris_token = nil
    respawn_failures = 0
    respawn_skip = 0
    return mpris_endpoint()
end

local MPV_RESPAWN_SKIP_POLLS = { 10, 20, 40, 80, 120 }

---@ffi
---@return string
function mpv_endpoint()
    if unloading then return "!shutdown" end
    if mpv_dir ~= nil then
        local port = utils.read_file(mpv_dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            mpv_respawn_failures = 0
            mpv_respawn_skip = 0
            mpv_last_failure = "!retry"
            return "http://127.0.0.1:" .. port .. "|" .. mpv_token
        end
    end
    if mpv_respawn_skip > 0 then
        mpv_respawn_skip = mpv_respawn_skip - 1
        return mpv_last_failure
    end
    stop_helper(mpv_dir)
    mpv_dir = nil
    mpv_token = nil
    mpv_respawn_failures = mpv_respawn_failures + 1
    mpv_respawn_skip = MPV_RESPAWN_SKIP_POLLS[math.min(mpv_respawn_failures, #MPV_RESPAWN_SKIP_POLLS)]
    local script = millennium.assets.read("backend/mpv_helper.py")
    if script == nil then
        mpv_last_failure = "!asset-helper"
        return mpv_last_failure
    end
    local base = utils.getenv("XDG_RUNTIME_DIR") or "/tmp"
    local dir = base .. "/nemusic-mpv-" .. utils.uuid()
    local token = utils.uuid()
    if not fs.create_directories(dir) then
        mpv_last_failure = "!mkdir:" .. base
        return mpv_last_failure
    end
    utils.exec("chmod 700 " .. shell_quote(dir))
    local path = dir .. "/helper.py"
    local audio_source = millennium.assets.read("backend/audio_source.py")
    if audio_source == nil or not utils.write_file(dir .. "/audio_source.py", audio_source) then
        mpv_last_failure = "!write-audio-source"
        return mpv_last_failure
    end
    if not utils.write_file(path, script) then
        mpv_last_failure = "!write-helper"
        return mpv_last_failure
    end
    if not utils.write_file(dir .. "/token", token) then
        mpv_last_failure = "!write-token"
        return mpv_last_failure
    end
    local log_path = base .. "/nemusic-mpv.log"
    mpv_dir = dir
    mpv_token = token
    launch_helper(path, dir, log_path)
    for _ = 1, 200 do
        local port = utils.read_file(dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            mpv_dir = dir
            mpv_token = token
            mpv_respawn_failures = 0
            mpv_respawn_skip = 0
            mpv_last_failure = "!retry"
            fs.remove(log_path)
            return "http://127.0.0.1:" .. port .. "|" .. token
        end
        utils.sleep(50)
    end
    local detail = last_log_line(log_path)
    if detail == "" then
        mpv_last_failure = "!spawn"
    else
        mpv_last_failure = "!spawn:" .. detail
    end
    return mpv_last_failure
end

---@ffi
---@return string
function unblock_stop()
    stop_helper(unblock_dir)
    unblock_dir = nil
    unblock_token = nil
    unblock_skip = 0
    return "ok"
end

---@ffi
---@return string
function unblock_endpoint()
    if unloading then return "!shutdown" end
    if unblock_dir ~= nil then
        local port = utils.read_file(unblock_dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            unblock_skip = 0
            return "http://127.0.0.1:" .. port .. "|" .. unblock_token
        end
    end
    if unblock_skip > 0 then
        unblock_skip = unblock_skip - 1
        return unblock_failure
    end
    unblock_stop()
    unblock_skip = 10
    local script = millennium.assets.read("dist/unblock_helper.cjs")
    if script == nil then return "!asset-helper" end
    local base = utils.getenv("XDG_RUNTIME_DIR") or "/tmp"
    local dir = base .. "/nemusic-unblock-" .. utils.uuid()
    if not fs.create_directories(dir) then return "!mkdir:" .. base end
    utils.exec("chmod 700 " .. shell_quote(dir))
    unblock_dir = dir
    unblock_token = utils.uuid()
    local path = dir .. "/helper.cjs"
    if not utils.write_file(path, script) then return "!write-helper" end
    if not utils.write_file(dir .. "/token", unblock_token) then return "!write-token" end
    local log_path = base .. "/nemusic-unblock.log"
    launch_helper(path, dir, log_path, "env -u LD_LIBRARY_PATH -u LD_PRELOAD node")
    for _ = 1, 20 do
        local port = utils.read_file(dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            unblock_skip = 0
            fs.remove(log_path)
            return "http://127.0.0.1:" .. port .. "|" .. unblock_token
        end
        utils.sleep(50)
    end
    local detail = last_log_line(log_path)
    unblock_failure = detail == "" and "!spawn" or "!spawn:" .. detail
    return unblock_failure
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
    stop_helper(mpris_dir)
    stop_helper(mpv_dir)
    unblock_stop()
    mpris_dir = nil
    mpris_token = nil
    mpv_dir = nil
    mpv_token = nil
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
