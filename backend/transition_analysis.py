"""有界的歌曲首尾分析；ffmpeg 不可用或读取失败时保留固定时长过渡。"""
import array
import math
import shutil
import subprocess
import sys
import threading
import statistics

from audio_source import audio_headers

SAMPLE_RATE = 8000
FRAME_SECONDS = 0.1
BEAT_FRAME = 0.01
SMART_WINDOW = 36
SMART_MIN_SECONDS = 8.0
SMART_MAX_SECONDS = 30.0
SMART_RAMP_SECONDS = 2.5
SMART_RAMP_FRACTION = 0.15
# 只允许小幅变速：超过这个范围要么听出拉伸痕迹，要么其实是半速/倍速关系。
SMART_TEMPO_RANGE = (0.92, 1.08)


def envelope(raw):
    samples = array.array("f")
    samples.frombytes(raw[:len(raw) // 4 * 4])
    if sys.byteorder != "little":
        samples.byteswap()
    step = int(SAMPLE_RATE * FRAME_SECONDS)
    return [math.sqrt(sum(value * value for value in samples[i:i + step]) / step)
            for i in range(0, len(samples) - step + 1, step)]


def transition_plan(tail, head, maximum):
    """只缩短密集段落的重叠，安静首尾允许更长过渡；最多略去两秒静音。"""
    if not tail or not head:
        return {"seconds": maximum, "skip": 0, "trim": 0, "analyzed": False}
    peak = max(max(tail), max(head), 0.001)
    silence = max(0.0005, peak * 0.015)
    leading = next((i for i, value in enumerate(head) if value > silence), 0)
    trailing = next((i for i, value in enumerate(reversed(tail)) if value > silence), 0)
    skip = min(2, leading * FRAME_SECONDS)
    trim = min(2, trailing * FRAME_SECONDS)
    tail_end = max(1, len(tail) - round(trim / FRAME_SECONDS))
    head_start = min(len(head) - 1, round(skip / FRAME_SECONDS))
    window = max(1, min(round(maximum / FRAME_SECONDS), tail_end, len(head) - head_start))
    tail_level = sum(tail[max(0, tail_end - window):tail_end]) / window
    head_level = sum(head[head_start:head_start + window]) / window
    # 首尾都响时减少旋律重叠；它不推断节拍，也不改变歌曲速度。
    dense = min(tail_level, head_level) / peak
    seconds = maximum if dense < 0.25 else max(1, maximum * (1 - min(0.7, dense)))
    return {"seconds": round(seconds, 2), "skip": skip, "trim": trim, "analyzed": True}


def drum_onsets(samples):
    """10 ms 的低频/宽频瞬态；低频权重让底鼓比持续旋律更影响拍点。"""
    step = round(SAMPLE_RATE * BEAT_FRAME)
    alpha = 1 - math.exp(-2 * math.pi * 180 / SAMPLE_RATE)
    low = 0
    bass, full = [], []
    for start in range(0, len(samples) - step + 1, step):
        low_energy = full_energy = 0
        for sample in samples[start:start + step]:
            low += alpha * (sample - low)
            low_energy += low * low
            full_energy += sample * sample
        bass.append(math.sqrt(low_energy / step))
        full.append(math.sqrt(full_energy / step))
    if not bass:
        return []
    bass_peak, full_peak = max(max(bass), 0.0001), max(max(full), 0.0001)
    onset = [0.0] * len(bass)
    for i in range(1, len(bass)):
        # 与过去 30 ms 的能量比较，保留鼓击起点而不是波形周期。
        lo = min(bass[max(0, i - 3):i])
        hi = min(full[max(0, i - 3):i])
        onset[i] = 0.75 * max(0, bass[i] - lo) / bass_peak + 0.25 * max(0, full[i] - hi) / full_peak
    return onset


def bar_offset(onset, peaks, period, anchor):
    """在四个拍位里选能量最像小节头的一个；差异不明显时不猜。"""
    totals = [0.0] * 4
    counts = [0] * 4
    for index in peaks:
        beat = round((index - anchor) / period)
        totals[beat % 4] += onset[index]
        counts[beat % 4] += 1
    means = [total / count if count else 0.0 for total, count in zip(totals, counts)]
    best = max(range(4), key=lambda offset: means[offset])
    ordered = sorted(means, reverse=True)
    if ordered[1] <= 0 or ordered[0] < ordered[1] * 1.12:
        return None
    return best


def beat_grid(samples):
    """估计局部 BPM/相位/小节头并拒绝缺少稳定鼓击的片段；不猜测调性或和声。"""
    onset = drum_onsets(samples)
    if len(onset) < 800 or max(onset, default=0) < 0.08:
        return None
    threshold = max(0.04, max(onset) * 0.18, statistics.mean(onset) * 2)
    peaks = []
    for i in range(2, len(onset) - 2):
        if onset[i] < threshold or onset[i] != max(onset[i - 2:i + 3]):
            continue
        if peaks and i - peaks[-1] < 18:
            if onset[i] > onset[peaks[-1]]:
                peaks[-1] = i
        else:
            peaks.append(i)
    if len(peaks) < 12:
        return None
    # 相邻及隔拍间距共同投票，避免只靠一个峰值判成半速/倍速。
    candidates = set()
    for index, point in enumerate(peaks):
        for following in peaks[index + 1:index + 5]:
            distance = following - point
            for beats in range(1, 5):
                period = distance / beats
                if 60 / 180 / BEAT_FRAME <= period <= 60 / 70 / BEAT_FRAME:
                    candidates.add(round(period, 1))
    total = sum(onset[index] for index in peaks)
    best = None
    for period in sorted(candidates):
        for anchor in peaks[:min(16, len(peaks))]:
            matched = [index for index in peaks if abs((index - anchor + period / 2) % period - period / 2) <= 4]
            coverage = sum(onset[index] for index in matched) / total
            first = anchor + math.ceil((peaks[0] - anchor) / period) * period
            count = max(1, (peaks[-1] - first) / period + 1)
            occupancy = min(1, len(matched) / count)
            score = coverage * occupancy
            if best is None or score > best[0]:
                best = (score, period, anchor, matched, coverage, occupancy)
    if not best or best[0] < 0.62 or best[4] < 0.75 or best[5] < 0.7:
        return None
    _, frame_period, anchor, matched, _, _ = best
    # 回归消除 10 ms 帧量化带来的 BPM 偏差，否则长过渡会渐渐错拍。
    pairs = [(round((index - anchor) / frame_period), index) for index in matched]
    mean_x = statistics.mean(x for x, _ in pairs)
    mean_y = statistics.mean(y for _, y in pairs)
    variance = sum((x - mean_x) ** 2 for x, _ in pairs)
    if not variance:
        return None
    frame_period = sum((x - mean_x) * (y - mean_y) for x, y in pairs) / variance
    phase = (mean_y - frame_period * mean_x) * BEAT_FRAME
    residual = max(abs(y * BEAT_FRAME - (phase + x * frame_period * BEAT_FRAME)) for x, y in pairs)
    if residual > 0.055:
        return None
    period = frame_period * BEAT_FRAME
    if not 70 <= 60 / period <= 180:
        return None
    offset = bar_offset(onset, peaks, frame_period, anchor)
    bar = (phase + offset * period) % (4 * period) if offset is not None else None
    return {"bpm": 60 / period, "period": period, "phase": phase % period, "bar": bar,
            "first": peaks[0] * BEAT_FRAME, "last": peaks[-1] * BEAT_FRAME,
            "confidence": best[0]}


def first_grid_point(first, phase, step):
    """phase + k*step 里第一个不早于 first 的点。"""
    return phase + math.ceil((first - phase) / step) * step


def smart_plan(tail_samples, head_samples, tail_start, duration, fallback):
    """按鼓点对齐两首歌：对齐拍点、把新歌小幅变速拉齐周期，再安排 8–30 秒重叠。"""
    tail, head = beat_grid(tail_samples), beat_grid(head_samples)
    plan = {**fallback, "mode": "normal", "reason": "unstable-beats"}
    if not tail or not head:
        return plan
    ratio = tail["bpm"] / head["bpm"]
    # 只允许小幅变速，不用倍速猜测强行凑拍。
    if not SMART_TEMPO_RANGE[0] <= ratio <= SMART_TEMPO_RANGE[1]:
        return {**plan, "reason": "tempo-gap"}
    # 新歌优先从自己的小节头接入（保留前奏最多两秒），没有可靠小节就退回第一拍。
    skip = first_grid_point(head["first"] - 0.05, head["phase"], head["period"])
    bar_aligned = head["bar"] is not None and tail["bar"] is not None
    if bar_aligned:
        skip = first_grid_point(head["first"] - 0.05, head["bar"], 4 * head["period"])
    if skip > 2:
        skip = first_grid_point(head["first"] - 0.05, head["phase"], head["period"])
    if skip > 2:
        return {**plan, "reason": "late-intro-beat"}
    # 旧歌也从拍点（有小节信息就是小节头）开始，长度取 4 拍的整数倍。
    tail_phase = tail_start + (tail["bar"] if bar_aligned else tail["phase"])
    tail_step = 4 * tail["period"] if bar_aligned else tail["period"]
    end = min(duration - fallback["trim"], tail_start + tail["last"] + tail["period"])
    # 变速后的新歌消耗得比旧歌快 ratio 倍，安排长度时要给它留够余量。
    available = min(end - tail_start, max(0.0, head["last"] - skip) / ratio)
    beats = int(min(SMART_MAX_SECONDS, available) / tail["period"]) // 4 * 4
    if beats * tail["period"] < SMART_MIN_SECONDS:
        return {**plan, "reason": "short-beat-window"}
    desired = end - beats * tail["period"]
    start = tail_phase + math.floor((desired - tail_phase) / tail_step) * tail_step
    if start < max(tail_start, tail_start + tail["first"] - 0.05):
        start += 4 * tail["period"]
        beats -= 4
    seconds = beats * tail["period"]
    if seconds < SMART_MIN_SECONDS or duration - start > SMART_MAX_SECONDS + 1 or start + seconds > duration:
        return {**plan, "reason": "short-beat-window"}
    return {**fallback, "mode": "smart", "reason": "beat-matched", "startAt": round(start, 3),
            "seconds": round(seconds, 3), "skip": round(skip, 3),
            "trim": round(max(0.0, duration - start - seconds), 3),
            "ratio": round(ratio, 4), "ramp": round(min(SMART_RAMP_SECONDS, seconds * SMART_RAMP_FRACTION), 2),
            "beatPeriod": round(tail["period"], 4), "barAligned": bar_aligned,
            "fromBpm": round(tail["bpm"], 2), "toBpm": round(head["bpm"], 2),
            "confidence": round(min(tail["confidence"], head["confidence"]), 3)}


def fade_timing(plan, position, song_end, margin=0.12):
    """把分析结果翻译成接管这一刻的淡出参数；错过拍点就顺延，接不上就退回普通淡化。"""
    position = max(0.0, float(position or 0.0))
    maximum = max(0.0, float(plan.get("seconds") or 0.0))
    trim = max(0.0, float(plan.get("trim") or 0.0))
    timing = {"start": position, "duration": maximum, "stretch": 1.0, "ramp": 0.0, "waiting": False}
    if song_end:
        timing["duration"] = min(maximum, max(0.1, float(song_end) - position - trim))
    if plan.get("mode") != "smart" or plan.get("startAt") is None:
        return timing
    period = max(0.05, float(plan.get("beatPeriod") or 0.5))
    start_at = float(plan["startAt"])
    base = start_at
    if position + margin > base:
        base = start_at + math.ceil((position + margin - start_at) / period) * period
    duration = max(0.0, maximum - (base - start_at))
    if song_end:
        duration = min(duration, max(0.0, float(song_end) - base))
    # 迟到超过四拍或者只剩不到两小节：别硬凑拍点，直接按普通淡化处理。
    if base - start_at > 4 * period or duration < max(4.0, 4 * period):
        return timing
    return {"start": base, "duration": max(0.2, duration), "stretch": min(2.0, max(0.5, float(plan.get("ratio") or 1.0))),
            "ramp": min(float(plan.get("ramp") or 0.0), duration * 0.5), "waiting": base > position + 0.02}


class TransitionAnalysis:
    def __init__(self, current_url, duration, next_url, maximum, environment, mode="normal"):
        self.mode = "smart" if mode == "smart" else "normal"
        self.result = {"seconds": maximum, "skip": 0, "trim": 0, "analyzed": False,
                       "mode": "normal", "reason": "analysis-unavailable"}
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.process = None
        self.executable = shutil.which("ffmpeg", path=environment.get("PATH"))
        minimum = SMART_MIN_SECONDS if self.mode == "smart" else maximum
        if self.executable and duration > minimum:
            self.thread = threading.Thread(target=self.run, args=(current_url, duration, next_url, maximum, environment), daemon=True)
            self.thread.start()

    def read(self, url, start, seconds, environment):
        if self.cancelled.is_set():
            return b""
        headers = "".join(f"{key}: {value}\r\n" for key, value in audio_headers(url).items())
        command = [self.executable, "-nostdin", "-v", "error", "-rw_timeout", "4000000",
                   "-headers", headers, "-ss", str(start), "-i", url, "-t", str(seconds),
                   "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
        with self.lock:
            if self.cancelled.is_set():
                return b""
            process = self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                                      stderr=subprocess.DEVNULL, env=environment)
        try:
            output, _ = process.communicate(timeout=12)
            return output if process.returncode == 0 and not self.cancelled.is_set() else b""
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            return b""
        finally:
            with self.lock:
                if self.process is process:
                    self.process = None

    def run(self, current_url, duration, next_url, maximum, environment):
        try:
            window = SMART_WINDOW if self.mode == "smart" else maximum + 2
            tail_start = max(0, duration - window)
            tail = self.read(current_url, tail_start, window, environment)
            head = self.read(next_url, 0, window, environment)
            if not self.cancelled.is_set():
                # 普通回退仍只使用首尾短片段，避免长分析窗口改变原来的听感。
                normal_bytes = round((maximum + 2) * SAMPLE_RATE) * 4
                plan = {**transition_plan(envelope(tail[-normal_bytes:]), envelope(head[:normal_bytes]), maximum),
                        "mode": "normal", "reason": "normal"}
                if self.mode == "smart" and tail and head:
                    samples = []
                    for raw in (tail, head):
                        values = array.array("f")
                        values.frombytes(raw[:len(raw) // 4 * 4])
                        if sys.byteorder != "little":
                            values.byteswap()
                        samples.append(values)
                    plan = smart_plan(*samples, tail_start, duration, plan)
                if not self.cancelled.is_set():
                    self.result = plan
        except (OSError, ValueError):
            pass

    def close(self):
        self.cancelled.set()
        with self.lock:
            if self.process is not None:
                try:
                    self.process.kill()
                except OSError:
                    pass
