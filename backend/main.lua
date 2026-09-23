local logger = require("logger")
local millennium = require("millennium")

local function on_load()
    logger:info("NEMusicOnSteam loaded with Millennium " .. tostring(millennium.version()))
    millennium.ready()
end

local function on_frontend_loaded()
    logger:info("Steam UI is up. Open NetEase from the corner button, the View menu, or plugin settings.")
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
    },
}
