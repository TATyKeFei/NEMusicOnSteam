local logger = require("logger")
local millennium = require("millennium")

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
