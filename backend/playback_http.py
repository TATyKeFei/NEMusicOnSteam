"""本地外部播放辅助进程的 HTTP 接口和空闲回收。"""
import json
import os
import shutil
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDLE_TIMEOUT = 60
CLIENT_GONE_ERRORS = (BrokenPipeError, ConnectionResetError)


class PlaybackHttpServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], CLIENT_GONE_ERRORS):
            return
        super().handle_error(request, client_address)


class PlaybackHttpService:
    def start_http(self):
        self.loop = None
        self.last_seen = time.monotonic()
        self.stopping = False
        self.stop_event = threading.Event()
        if threading.current_thread() is threading.main_thread():
            # Lua 在 Steam 退出时发 TERM，唤醒主循环执行队列清理后再退出。
            signal.signal(signal.SIGTERM, lambda *_args: self.stop_event.set())
        self.server = PlaybackHttpServer(("127.0.0.1", 0), self.make_handler())
        self.server.daemon_threads = True

    def alive(self):
        return True

    def make_handler(self):
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, code, payload):
                body = b"" if code == 204 else json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "X-NEMusic-Token, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_OPTIONS(self):
                self.reply(204, {})

            def authorized(self):
                if self.headers.get("X-NEMusic-Token") != service.token:
                    self.reply(403, {"error": "forbidden"})
                    return False
                with service.lock:
                    service.last_seen = time.monotonic()
                return True

            def read_payload(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > 65536:
                        raise ValueError("invalid length")
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError("invalid payload")
                    return payload
                except (ValueError, json.JSONDecodeError):
                    return None

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path == "/state":
                    try:
                        self.reply(200, service.snapshot())
                    except (RuntimeError, OSError, ValueError) as error:
                        self.reply(502, {"error": str(error)})
                    return
                self.reply(404, {})

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path == "/configure" and hasattr(service, "configure"):
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        service.configure(payload)
                        self.reply(200, {})
                    except (RuntimeError, OSError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/load" or (self.path == "/prepare" and hasattr(service, "prepare")):
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        self.reply(200, service.prepare(payload) if self.path == "/prepare" else service.load(payload))
                    except (RuntimeError, OSError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/command":
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        self.reply(200, {"handled": service.command(payload)})
                    except (RuntimeError, OSError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/analyze" and hasattr(service, "analyze"):
                    payload = self.read_payload()
                    if payload is None:
                        self.reply(400, {"error": "无效请求"})
                        return
                    try:
                        self.reply(200, service.analyze(payload))
                    except (RuntimeError, OSError, ValueError) as error:
                        self.reply(400, {"error": str(error)})
                    return
                if self.path == "/shutdown":
                    service.close()
                    self.reply(200, {})
                    service.request_shutdown()
                    return
                self.reply(404, {})

        return Handler

    def request_shutdown(self):
        with self.lock:
            self.stopping = True
        self.stop_event.set()
        if self.loop is not None:
            self.loop()

    def run(self):
        self.loop = self.server.shutdown
        with open(os.path.join(self.runtime_dir, "port"), "w", encoding="ascii") as port_file:
            port_file.write(str(self.server.server_port))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            while not self.stop_event.wait(0.5):
                with self.lock:
                    if self.stopping:
                        break
                    expired = time.monotonic() - self.last_seen > IDLE_TIMEOUT
                if expired:
                    break
                if not self.alive():
                    break
        finally:
            self.server.shutdown()
            self.server.server_close()
            self.close()
            try:
                os.unlink(os.path.join(self.runtime_dir, "port"))
            except FileNotFoundError:
                pass
            shutil.rmtree(self.runtime_dir, ignore_errors=True)
