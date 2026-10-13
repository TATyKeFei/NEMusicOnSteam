#include "millennium/millennium_lifecycle.h"
#include <atomic>
#include <cstdlib>
#include <thread>

std::atomic<bool> started{false};
std::thread worker;

void cleanup()
{
    millennium_lifecycle::get().terminate.notify();
    worker.join();
}

int main()
{
    std::atexit(cleanup);
    worker = std::thread([]
    {
        auto& gate = millennium_lifecycle::get().terminate;
        std::unique_lock<std::mutex> lock(gate.mtx);
        started.store(true);
        gate.cv.wait(lock, [&gate] { return gate.flag.load(); });
    });
    while (!started.load()) std::this_thread::yield();
    std::lock_guard<std::mutex> lock(millennium_lifecycle::get().terminate.mtx);
}
