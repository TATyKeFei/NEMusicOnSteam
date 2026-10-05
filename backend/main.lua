local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

local mpris_dir = nil
local mpris_token = nil
local mpv_dir = nil
local mpv_token = nil

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
    if mpris_dir ~= nil then
        local port = utils.read_file(mpris_dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            respawn_failures = 0
            respawn_skip = 0
            return "http://127.0.0.1:" .. port .. "|" .. mpris_token
        end
        -- 辅助进程退出时会删掉自己的运行目录，所以端口文件消失就意味着上一个进程已经
        -- 没了，需要重新拉起一个。
        mpris_dir = nil
        mpris_token = nil
    end
    if respawn_skip > 0 then
        respawn_skip = respawn_skip - 1
        return "!retry"
    end
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
    if not utils.write_file(dir .. "/token", token) then return "!write-token" end
    -- 日志要放在运行目录之外：辅助进程退出时会清空该目录，一个在报出端口前就死掉的
    -- 辅助进程会把自己的回溯一起带走。
    local log_path = base .. "/nemusic-mpris.log"
    utils.exec("python3 " .. shell_quote(path) .. " " .. shell_quote(dir) .. " </dev/null >" .. shell_quote(log_path) .. " 2>&1 &")
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

local MPV_RESPAWN_SKIP_POLLS = { 10, 20, 40, 80, 120 }

---@ffi
---@return string
function mpv_endpoint()
    if mpv_dir ~= nil then
        local port = utils.read_file(mpv_dir .. "/port")
        if port ~= nil and port:match("^%d+$") then
            mpv_respawn_failures = 0
            mpv_respawn_skip = 0
            mpv_last_failure = "!retry"
            return "http://127.0.0.1:" .. port .. "|" .. mpv_token
        end
        mpv_dir = nil
        mpv_token = nil
    end
    if mpv_respawn_skip > 0 then
        mpv_respawn_skip = mpv_respawn_skip - 1
        return mpv_last_failure
    end
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
    if not utils.write_file(path, script) then
        mpv_last_failure = "!write-helper"
        return mpv_last_failure
    end
    if not utils.write_file(dir .. "/token", token) then
        mpv_last_failure = "!write-token"
        return mpv_last_failure
    end
    local log_path = base .. "/nemusic-mpv.log"
    utils.exec("python3 " .. shell_quote(path) .. " " .. shell_quote(dir) .. " </dev/null >" .. shell_quote(log_path) .. " 2>&1 &")
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

local function on_load()
    logger:info("NEMusicOnSteam loaded with Millennium " .. tostring(millennium.version()))
    millennium.ready()
end

local function on_frontend_loaded()
    logger:info("Steam UI is up. Open NetEase from the supernav link, the View menu, or plugin settings.")
end

local function on_unload()
    logger:info("NEMusicOnSteam unloading")
    local ok, err = pcall(function()
        millennium.call_frontend_method("shutdown", {})
    end)
    if not ok then
        logger:info("Frontend was already gone: " .. tostring(err))
    end
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
                    replace = [=[Ga.push({visible:!0,title:String.fromCharCode(0x7f51,0x6613,0x4e91,0x97f3,0x4e50),icon:(0,e.jsx)(d.Music,{}),route:r.BV.Settings.Music().replace(/music$/,"nemusic"),content:(0,e.jsx)(function NEMusicSettings(){try{var plugin=#{{self}};return plugin&&plugin.renderSettings?plugin.renderSettings():null}catch(error){console.error("[NEMusic] settings",error);return null}},{})});return Ga},[Kr,Ua])]=],
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
        {
            -- 当前版本的 Steam 把「库/社区」这一行放在同一个 SuperNav 函数里。插入一个真正的
            -- React 子节点，客户端才不会去删除这个外部 DOM 节点。标签用码点表示：打包后的
            -- Lua 和补丁替换器都会破坏原始非 ASCII 字符以及 \u 转义。
            find = [=[function Sr\(Or\)\{const Ar=\(0,d\.Sn\)\(\);return\(0,e\.jsxs\)\("div",\{className:mt\(\)\.SuperNav,children:\[\(0,e\.jsx\)\(fr,\{\}\),\(0,e\.jsx\)\(yr,\{\}\),\(0,e\.jsx\)\(Pt,\{\}\),\(0,e\.jsx\)\(gt,\{\}\),\(0,e\.jsx\)\(Te,\{\}\),\(0,e\.jsx\)\(Et,\{\}\),Ar&&\(0,e\.jsx\)\(qt,\{\}\)\]\}\)\}]=],
            file = [[chunk~[0-9a-f]+\.js]],
            transforms = {
                {
                    match = [=[function Sr\(Or\)\{const Ar=\(0,d\.Sn\)\(\);return\(0,e\.jsxs\)\("div",\{className:mt\(\)\.SuperNav,children:\[\(0,e\.jsx\)\(fr,\{\}\),\(0,e\.jsx\)\(yr,\{\}\),\(0,e\.jsx\)\(Pt,\{\}\),\(0,e\.jsx\)\(gt,\{\}\),\(0,e\.jsx\)\(Te,\{\}\),\(0,e\.jsx\)\(Et,\{\}\),Ar&&\(0,e\.jsx\)\(qt,\{\}\)\]\}\)\}]=],
                    replace = [=[function NEMusicOnSteamNav(){var st=c.useState("closed"),mode=st[0],setMode=st[1];c.useEffect(function(){var root=document.documentElement;var read=function(){setMode(root.getAttribute("data-nemusic-mode")||"closed")};read();var obs=new MutationObserver(read);obs.observe(root,{attributes:true,attributeFilter:["data-nemusic-mode"]});return function(){obs.disconnect()}},[]);var invoke=function(method){try{var plugin=#{{self}};if(plugin&&plugin[method])plugin[method]()}catch(err){console.error("[NEMusic]",err)}};return(0,e.jsx)("div",{id:"nemusic-nav-link",style:{marginLeft:"auto",height:"100%",WebkitAppRegion:"no-drag"},children:(0,e.jsx)(Ke.W1,{title:String.fromCharCode(0x7f51,0x6613,0x4e91,0x97f3,0x4e50),className:(0,p.A)(mt().SuperNavMenu,mode==="expanded"&&mt().Selected),popupClass:mt().MenuPopup,buttonClass:mt().MenuButton,disabledClass:mt().Disabled,bSuperNavBehavior:!0,onClick:function(){invoke("openPlayer")},menuItems:[{name:String.fromCharCode(0x6536,0x8d77),onClick:function(){invoke("collapsePlayer")}},{name:String.fromCharCode(0x5237,0x65b0),onClick:function(){invoke("reloadPlayer")}},{name:String.fromCharCode(0x5173,0x95ed),onClick:function(){invoke("closePlayer")}}],children:String.fromCharCode(0x7f51,0x6613,0x4e91)})})}function Sr(Or){const Ar=(0,d.Sn)();return(0,e.jsxs)("div",{className:mt().SuperNav,children:[(0,e.jsx)(fr,{}),(0,e.jsx)(yr,{}),(0,e.jsx)(Pt,{}),(0,e.jsx)(gt,{}),(0,e.jsx)(Te,{}),(0,e.jsx)(Et,{}),Ar&&(0,e.jsx)(qt,{}),(0,e.jsx)(NEMusicOnSteamNav,{})]})}]=],
                },
            },
        },
    },
}
