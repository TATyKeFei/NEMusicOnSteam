local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

local mpris_dir = nil
local mpris_token = nil

-- The frontend polls every 500ms, and a spawn attempt forks python3 and blocks this process for
-- up to a second while it boots. Without a breather a helper that cannot start at all stacked
-- those stalls back to back. Count skipped polls instead of reading a clock: utils.time_ms()
-- reports a negative value in this 32-bit Lua host, and an earlier deadline-based gate treated
-- its 0 sentinel as still in the future, so mpris_endpoint returned "" forever and never retried.
-- The first gap is 5s: a PyGObject cold boot often outlasts the 1s port wait below, and forking
-- a second helper while the first is still starting leaves two processes racing for the D-Bus
-- name — the loser keeps serving HTTP that MPRIS clients never see.
local RESPAWN_SKIP_POLLS = { 10, 20, 40, 80, 120 }
local respawn_failures = 0
local respawn_skip = 0

local function shell_quote(value)
    return "'" .. value:gsub("'", "'\\''") .. "'"
end

-- Every failure used to return "" and the frontend turned that into one message blaming
-- Python/PyGObject/D-Bus, which sent users installing packages they already had. Return a
-- "!<code>:<detail>" reason instead so the settings page can name the step that failed.
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
        -- The helper deletes its runtime directory when it exits, so a missing
        -- port file means the previous process is gone and a new one is needed.
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
    -- Keep the log outside the runtime directory: the helper wipes that directory on exit,
    -- so a helper that dies before announcing its port would take its own traceback with it.
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
            -- Menu label stays ASCII. Packed Lua corrupts raw non-ASCII and the View menu would show mojibake.
            transforms = {
                {
                    match = [[\{name:"#Menu_Library",steamURL:"steam://open/library/view/home"\}]],
                    replace = [[{name:"\u7f51\u6613\u4e91\u97f3\u4e50",onClick:function(){try{var plugin=#{{self}};if(plugin&&plugin.openPlayer)plugin.openPlayer()}catch(e){console.error("[NEMusic]",e)}}},{name:"#Menu_Library",steamURL:"steam://open/library/view/home"}]],
                },
            },
        },
        {
            -- Current Steam builds the library/community row in one SuperNav function. Insert a real React child
            -- so the client stops deleting an outside DOM node. Labels are code points: packed Lua and
            -- the patch replacer both mangle raw non-ASCII and backslash-u escapes.
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
