local function fixture(ready, options)
    options = options or {}
    local files = {}
    local launches = {}
    local removed = {}
    local commands = {}
    local serial = 0
    local environment
    local during_stop
    local modules = {
        logger = { info = function() end },
        millennium = { assets = { read = function(path)
            if path == options.missing_asset then return nil end
            return "helper"
        end } },
        utils = {
            getenv = function() return "/tmp" end,
            uuid = function() serial = serial + 1; return tostring(serial) end,
            read_file = function(path) return files[path] end,
            write_file = function(path, value)
                if options.failed_write and path:sub(-#options.failed_write) == options.failed_write then return false end
                files[path] = value
                return true
            end,
            exec = function(command)
                table.insert(commands, command)
                if command:match("^setsid ") then
                    local directory = assert(command:match("helper_pid >'([^']+)/pid'"))
                    local pid = tostring(5000 + #launches)
                    files[directory .. "/pid"] = pid
                    if ready then files[directory .. "/port"] = tostring(12000 + #launches) end
                    table.insert(launches, { directory = directory, pid = pid })
                end
            end,
            sleep = function()
                if during_stop then during_stop(environment) end
            end,
        },
        fs = {
            create_directories = function() return true end,
            remove = function(path) files[path] = nil end,
            remove_all = function(directory)
                table.insert(removed, directory)
                for path in pairs(files) do
                    if path:sub(1, #directory + 1) == directory .. "/" then files[path] = nil end
                end
            end,
        },
    }
    environment = setmetatable({
        require = function(name) return assert(modules[name]) end,
    }, { __index = _G })
    local plugin = assert(loadfile("backend/main.lua", "t", environment))()
    return {
        backend = environment,
        unload = plugin.on_unload,
        files = files,
        launches = launches,
        removed = removed,
        commands = commands,
        during_stop = function(callback) during_stop = callback end,
    }
end

local function assert_stopped(runtime, launch)
    local terminated = false
    local killed = false
    for _, command in ipairs(runtime.commands) do
        if command:find("kill -TERM -- -" .. launch.pid, 1, true) then terminated = true end
        if command:find("kill -KILL -- -" .. launch.pid, 1, true) then killed = true end
    end
    assert(terminated and killed, "helper process group was not stopped")
end

local active = fixture(true)
assert(active.backend.mpris_endpoint():match("^http://"))
assert(active.backend.mpv_endpoint():match("^http://"))
assert(active.backend.mpd_endpoint():match("^http://"))
assert(active.backend.unblock_endpoint():match("^http://"))
active.during_stop(function(backend)
    assert(backend.mpris_endpoint() == "!shutdown")
    assert(backend.mpris_reconnect() == "!shutdown")
    assert(backend.mpv_endpoint() == "!shutdown")
    assert(backend.mpd_endpoint() == "!shutdown")
    assert(backend.unblock_endpoint() == "!shutdown")
end)
active.unload()
assert(#active.launches == 4 and #active.removed == 4)
for _, launch in ipairs(active.launches) do assert_stopped(active, launch) end
local command_count = #active.commands
active.unload()
assert(#active.commands == command_count)

for _, method in ipairs({ "mpris_endpoint", "mpv_endpoint", "mpd_endpoint", "unblock_endpoint" }) do
    local retry_result = method == "mpris_endpoint" and "!retry" or "!spawn"
    local pending = fixture(false)
    assert(pending.backend[method]() == "!spawn")
    assert(#pending.launches == 1)
    assert(pending.backend[method]() == retry_result)
    assert(#pending.launches == 1)
    pending.files[pending.launches[1].directory .. "/pid"] = nil
    pending.unload()
    assert_stopped(pending, pending.launches[1])
    assert(#pending.removed == 1)

    local delayed = fixture(false)
    assert(delayed.backend[method]() == "!spawn")
    delayed.files[delayed.launches[1].directory .. "/port"] = "12001"
    assert(delayed.backend[method]():match("^http://127%.0%.0%.1:12001|"))
    assert(#delayed.launches == 1)
    delayed.unload()
    assert_stopped(delayed, delayed.launches[1])

    local retry = fixture(false)
    assert(retry.backend[method]() == "!spawn")
    for _ = 1, 10 do assert(retry.backend[method]() == retry_result) end
    assert(retry.backend[method]() == "!spawn")
    assert(#retry.launches == 2)
    assert_stopped(retry, retry.launches[1])
    retry.unload()
    assert_stopped(retry, retry.launches[2])
end

local reconnect = fixture(false)
assert(reconnect.backend.mpris_endpoint() == "!spawn")
assert(reconnect.backend.mpris_reconnect() == "!spawn")
assert(#reconnect.launches == 2)
assert_stopped(reconnect, reconnect.launches[1])
reconnect.unload()
assert_stopped(reconnect, reconnect.launches[2])

print("PASS helper shutdown, startup timeouts, delayed readiness, retries, and reconnect cleanup")

local shutdown = fixture(true)
assert(shutdown.backend.mpris_endpoint():match("^http://"))
assert(shutdown.backend.mpv_endpoint():match("^http://"))
assert(shutdown.backend.mpd_endpoint():match("^http://"))
assert(shutdown.backend.unblock_endpoint():match("^http://"))
assert(shutdown.backend.shutdown_backend() == "ok")
assert(#shutdown.removed == 4)
for _, launch in ipairs(shutdown.launches) do assert_stopped(shutdown, launch) end
assert(shutdown.backend.mpris_endpoint() == "!shutdown")
print("PASS Steam exit cleans helper processes before backend unload")

local unblock = fixture(true)
assert(#unblock.launches == 0)
assert(unblock.backend.unblock_endpoint():match("^http://"))
local first = unblock.launches[1]
assert(unblock.backend.unblock_stop() == "ok")
assert_stopped(unblock, first)
assert(unblock.backend.unblock_endpoint():match("^http://"))
assert(#unblock.launches == 2)
unblock.unload()
assert_stopped(unblock, unblock.launches[2])
print("PASS optional matcher starts on demand and stops on disable")

local packaged = fixture(true)
assert(packaged.backend.mpris_endpoint():match("^http://"))
local directory = packaged.launches[1].directory
for _, name in ipairs({ "helper.py", "recognition.py", "audio_source.py", "download_files.py", "audio_tags.py", "token" }) do
    assert(packaged.files[directory .. "/" .. name], "missing helper dependency: " .. name)
end
packaged.unload()

for _, item in ipairs({
    { "mpris_endpoint", "backend/download_files.py", "!asset-download-files" },
    { "mpris_endpoint", "backend/audio_tags.py", "!asset-audio-tags" },
    { "mpv_endpoint", "backend/audio_source.py", "!asset-audio-source" },
    { "mpv_endpoint", "backend/track_analysis.py", "!asset-track-analysis" },
    { "mpv_endpoint", "backend/pcm_mixer.py", "!asset-pcm-mixer" },
    { "mpv_endpoint", "backend/playback_http.py", "!asset-playback-http" },
    { "mpd_endpoint", "backend/playback_http.py", "!asset-playback-http" },
    { "unblock_endpoint", "dist/unblock_helper.cjs", "!asset-helper" },
}) do
    local missing = fixture(true, { missing_asset = item[2] })
    assert(missing.backend[item[1]]() == item[3])
    assert(#missing.launches == 0)
end
for _, method in ipairs({ "mpris_endpoint", "mpv_endpoint", "mpd_endpoint", "unblock_endpoint" }) do
    local failed = fixture(true, { failed_write = "/token" })
    assert(failed.backend[method]() == "!write-token")
    assert(#failed.launches == 0 and #failed.removed == 1, "failed preparation leaked a runtime directory")
    failed.unload()
    assert(#failed.removed == 1)
end
print("PASS helper dependencies are deployed and preparation failures clean up")
