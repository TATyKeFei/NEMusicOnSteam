#include "mep/crash_event_bus.h"
#include <cstdlib>
#include <string>

int listener_id;

void cleanup()
{
    mep::crash_event_bus::instance().remove_listener(listener_id);
}

int main()
{
    std::atexit(cleanup);
    std::string message(128, 'x');
    listener_id = mep::crash_event_bus::instance().add_listener([message](const mep::crash_event&)
    {
        if (message.empty()) std::abort();
    });
}
