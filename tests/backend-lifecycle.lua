local function fixture(ready)
    local files = {}
    local launches = {}
    local removed = {}
    local commands = {}
    local serial = 0
    local environment
    local during_stop
    local modules = {
        logger = { info = function() end },
        millennium = { assets = { read = function() return "helper" end } },
        utils = {
            getenv = function() return "/tmp" end,
            uuid = function() serial = serial + 1; return tostring(serial) end,
            read_file = function(path) return files[path] end,
            write_file = function(path, value) files[path] = value; return true end,
            exec = function(command)
                table.insert(commands, command)
                if command:match("^setsid python3") then
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
active.during_stop(function(backend)
    assert(backend.mpris_endpoint() == "!shutdown")
    assert(backend.mpris_reconnect() == "!shutdown")
    assert(backend.mpv_endpoint() == "!shutdown")
end)
active.unload()
assert(#active.launches == 2 and #active.removed == 2)
for _, launch in ipairs(active.launches) do assert_stopped(active, launch) end
local command_count = #active.commands
active.unload()
assert(#active.commands == command_count)

for _, method in ipairs({ "mpris_endpoint", "mpv_endpoint" }) do
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
assert(shutdown.backend.shutdown_backend() == "ok")
assert(#shutdown.removed == 2)
for _, launch in ipairs(shutdown.launches) do assert_stopped(shutdown, launch) end
assert(shutdown.backend.mpris_endpoint() == "!shutdown")
print("PASS Steam exit cleans helper processes before backend unload")
