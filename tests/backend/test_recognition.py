import base64
import io
import json
import subprocess
import time
import unittest
from unittest.mock import Mock, patch

import recognition


class RecorderTests(unittest.TestCase):
    def test_system_and_microphone_select_different_devices(self):
        with patch.object(recognition.shutil, "which", return_value="/usr/bin/parec"):
            system = recognition.recorder_command("system")
            microphone = recognition.recorder_command("microphone")
        self.assertIn("--device=@DEFAULT_MONITOR@", system)
        self.assertIn("--device=@DEFAULT_SOURCE@", microphone)
        self.assertIn("--rate=8000", system)
        self.assertIn("--format=float32le", system)

    def test_ffmpeg_fallback_and_missing_recorder(self):
        with patch.object(recognition.shutil, "which", side_effect=[None, "/usr/bin/ffmpeg"]):
            command = recognition.recorder_command("system")
        self.assertIn("@DEFAULT_MONITOR@", command)
        self.assertIn("f32le", command)
        with patch.object(recognition.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "parec"):
                recognition.recorder_command("microphone")
        with self.assertRaises(ValueError):
            recognition.recorder_command("arbitrary-device; command")

    def test_six_seconds_are_captured_in_memory_and_recorder_is_stopped(self):
        service = recognition.RecognitionService()
        service.job = job = {"stage": "recording", "id": "test"}
        process = Mock()
        process.stdout.fileno.return_value = 3
        process.poll.return_value = None
        samples = b"\x00\x00\x00\x3f" * (recognition.SAMPLE_BYTES // 4)
        source = io.BytesIO(samples)
        with patch.object(recognition.subprocess, "Popen", return_value=process), \
                patch.object(recognition.select, "select", return_value=([process.stdout], [], [])), \
                patch.object(recognition.os, "read", side_effect=lambda _fd, count: source.read(count)):
            service.record(job, ["parec"])
        self.assertEqual(job["stage"], "recorded")
        self.assertEqual(base64.b64decode(job["samples"]), samples)
        process.terminate.assert_called_once()
        process.stdout.close.assert_called_once()
        self.assertIsNone(service.process)

    def test_timeout_and_device_failure_stop_the_recorder(self):
        for ready, chunk in ((False, b""), (True, b"")):
            service = recognition.RecognitionService()
            service.job = job = {"stage": "recording", "id": "test"}
            process = Mock()
            process.poll.return_value = None
            with patch.object(recognition.subprocess, "Popen", return_value=process), \
                    patch.object(recognition.select, "select", return_value=([process.stdout] if ready else [], [], [])), \
                    patch.object(recognition.os, "read", return_value=chunk):
                service.record(job, ["parec"])
            self.assertEqual(job["stage"], "error")
            self.assertEqual(job["samples"], "")
            process.terminate.assert_called_once()

    def test_recorder_that_does_not_terminate_is_killed(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("parec", 1), 0]
        recognition.RecognitionService.stop_process(process)
        process.kill.assert_called_once()


class RecognitionJobTests(unittest.TestCase):
    def setUp(self):
        self.service = recognition.RecognitionService()

    def test_only_one_job_can_record_at_once(self):
        with patch.object(recognition, "recorder_command", return_value=["parec"]), \
                patch.object(recognition.threading, "Thread"):
            job_id = self.service.start("system")
            with self.assertRaisesRegex(ValueError, "已有识曲任务"):
                self.service.start("microphone")
        self.assertEqual(self.service.snapshot()["id"], job_id)
        self.assertTrue(self.service.active())

    def test_cancel_stops_recording_and_ignores_late_result(self):
        self.service.job = job = {"id": "current", "stage": "recording", "samples": "data"}
        process = self.service.process = Mock()
        process.poll.return_value = None
        self.service.cancel("other")
        process.terminate.assert_not_called()
        self.service.cancel("current")
        process.terminate.assert_called_once()
        self.assertFalse(self.service.update(job, stage="done", results=[{"id": 1}]))
        self.assertEqual(job["stage"], "cancelled")
        self.assertEqual(job["samples"], "")
        self.assertFalse(self.service.active())

    def test_cancel_before_worker_starts_never_opens_the_microphone(self):
        self.service.job = job = {"id": "current", "stage": "cancelled"}
        with patch.object(recognition.subprocess, "Popen") as spawn:
            self.service.record(job, ["parec"])
        spawn.assert_not_called()

    def test_stale_match_is_rejected_and_samples_are_released_on_submit(self):
        self.service.job = job = {"id": "current", "stage": "recorded", "samples": "raw"}
        with self.assertRaises(ValueError):
            self.service.submit("old", "YWJjZGVm")
        with patch.object(recognition.threading, "Thread") as worker:
            self.service.submit("current", "YWJjZGVm")
            worker.return_value.start.assert_called_once()
        self.assertEqual(job["stage"], "matching")
        self.assertEqual(job["samples"], "")
        with self.assertRaises(ValueError):
            self.service.submit("current", "YWJjZGVm")

    def test_network_error_is_reported_and_orphaned_job_expires(self):
        self.service.job = job = {"id": "current", "stage": "matching", "samples": ""}
        with patch.object(recognition, "match_fingerprint", side_effect=OSError("offline")):
            self.service.match(job, "YWJjZGVm")
        self.assertEqual(job["stage"], "error")
        self.assertIn("offline", job["error"])
        job.update(stage="recorded", updated=time.monotonic() - 60, samples="raw")
        self.service.expire()
        self.assertEqual(job["stage"], "cancelled")
        self.assertEqual(job["samples"], "")

    def test_engine_is_cached_only_after_success(self):
        with patch.object(recognition, "load_engine", side_effect=[OSError("offline"), "engine"]) as loader:
            with self.assertRaises(OSError):
                self.service.engine()
            self.assertEqual(self.service.engine(), "engine")
            self.assertEqual(self.service.engine(), "engine")
        self.assertEqual(loader.call_count, 2)


class FingerprintTests(unittest.TestCase):
    def test_engine_integrity_is_verified(self):
        with patch.object(recognition, "urlopen", return_value=io.BytesIO(b"changed script")):
            with self.assertRaisesRegex(ValueError, "校验失败"):
                recognition.load_engine()

    def test_matching_uses_official_endpoint_and_normalizes_results(self):
        payload = {"code": 200, "data": {"result": [{"song": {
            "id": 123, "name": "歌曲", "artists": [{"name": "歌手"}], "album": {"name": "专辑"},
        }}]}}
        with patch.object(recognition, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())) as fetch:
            result = recognition.match_fingerprint("YWJjZGVm")
        request = fetch.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://interface.music.163.com/api/music/audio/match?"))
        self.assertIn("duration=6", request.full_url)
        self.assertIn("rawdata=YWJjZGVm", request.full_url)
        self.assertEqual(result, [{"id": 123, "name": "歌曲", "artist": "歌手", "album": "专辑"}])

    def test_no_match_is_distinct_from_service_failure(self):
        with patch.object(recognition, "urlopen", return_value=io.BytesIO(b'{"code":200,"data":{"result":null}}')):
            self.assertEqual(recognition.match_fingerprint("YWJjZGVm"), [])
        with patch.object(recognition, "urlopen", return_value=io.BytesIO(b'{"code":400}')):
            with self.assertRaisesRegex(ValueError, "400"):
                recognition.match_fingerprint("YWJjZGVm")

    def test_invalid_fingerprints_are_rejected_before_network_access(self):
        with patch.object(recognition, "urlopen") as fetch:
            for value in (None, "", "!" * 16, "a" * 24001):
                with self.assertRaises(ValueError):
                    recognition.match_fingerprint(value)
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
