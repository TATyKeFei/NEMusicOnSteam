"""歌单智能排序使用的单曲节奏、能量与调性分析。"""
import array
import math
import shutil
import statistics
import subprocess
import sys

from audio_source import audio_headers

SAMPLE_RATE = 8000
BEAT_FRAME = 0.01
BEAT_CORR_MIN = 0.35
BEAT_OCCUPANCY_MIN = 0.35
BEAT_RESIDUAL_MAX = 0.035
BEAT_TOLERANCE = 4
ANALYZE_WINDOW = 18
ANALYZE_MIN_SECONDS = 6.0
KEY_MIN_HZ = 55.0
KEY_MAX_HZ = 2000.0
KEY_FRAME = 2048
KEY_FRAMES = 16
# Krumhansl-Schmuckler 的调性感知画像（大调/小调），按音级顺序排列。
KEY_PROFILES = {
    False: (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88),
    True: (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17),
}


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
    for index in range(1, len(bass)):
        # 与过去 30 ms 的能量比较，保留鼓击起点而不是波形周期。
        lo = min(bass[max(0, index - 3):index])
        hi = min(full[max(0, index - 3):index])
        onset[index] = 0.75 * max(0, bass[index] - lo) / bass_peak + 0.25 * max(0, full[index] - hi) / full_peak
    return onset


def pulse_period(onset):
    """自相关找 70–180 BPM 里最强的脉冲周期和相关度，细化到亚帧精度。"""
    size = len(onset)
    low = max(2, round(60 / 180 / BEAT_FRAME))
    high = round(60 / 70 / BEAT_FRAME)
    prefix = [0.0]
    for value in onset:
        prefix.append(prefix[-1] + value * value)
    values = {}
    for lag in range(low, high + 1):
        cross = 0.0
        for index in range(size - lag):
            cross += onset[index] * onset[index + lag]
        scale = math.sqrt(prefix[size - lag] * (prefix[size] - prefix[lag]))
        values[lag] = cross / scale if scale > 1e-12 else 0.0
    best = max(values, key=lambda lag: values[lag])
    strength = values[best]
    left = values.get(best - 1, strength)
    right = values.get(best + 1, strength)
    denominator = left - 2 * strength + right
    drift = 0.5 * (left - right) / denominator if abs(denominator) > 1e-9 else 0.0
    return best + max(-0.5, min(0.5, drift)), strength


def comb_offset(onset, frame_period):
    """梳状滤波选相位：让所有网格点附近的瞬态能量和最大。"""
    best_offset, best_energy = 0, -1.0
    for offset in range(int(math.ceil(frame_period))):
        total = 0.0
        position = float(offset)
        while position - BEAT_TOLERANCE < len(onset):
            low = max(0, int(round(position - BEAT_TOLERANCE)))
            high = min(len(onset), int(round(position + BEAT_TOLERANCE)) + 1)
            total += sum(onset[low:high])
            position += frame_period
        if total > best_energy:
            best_energy, best_offset = total, offset
    return best_offset


def bpm_from_pulse(onset, peaks):
    """按自相关周期铺拍点网格。密八分、摇摆、弱鼓点这些真实音乐不再被峰覆盖率门限挡掉。"""
    frame_period, strength = pulse_period(onset)
    if strength < BEAT_CORR_MIN:
        return None
    anchor = comb_offset(onset, frame_period)
    matched = [index for index in peaks
               if abs((index - anchor + frame_period / 2) % frame_period - frame_period / 2) <= BEAT_TOLERANCE]
    if len(matched) < 8:
        return None
    pairs = [(round((index - anchor) / frame_period), index) for index in matched]
    mean_x = statistics.mean(beat for beat, _ in pairs)
    mean_y = statistics.mean(frame for _, frame in pairs)
    variance = sum((beat - mean_x) ** 2 for beat, _ in pairs)
    if not variance:
        return None
    frame_period = sum((beat - mean_x) * (frame - mean_y) for beat, frame in pairs) / variance
    phase = (mean_y - frame_period * mean_x) * BEAT_FRAME
    residual = max(abs(frame * BEAT_FRAME - (phase + beat * frame_period * BEAT_FRAME)) for beat, frame in pairs)
    period = frame_period * BEAT_FRAME
    slots = max(1, (matched[-1] - matched[0]) / frame_period + 1)
    occupancy = min(1, len(matched) / slots)
    if residual > BEAT_RESIDUAL_MAX or occupancy < BEAT_OCCUPANCY_MIN or not 70.0 <= 60 / period <= 180.0:
        return None
    return 60 / period


def estimate_bpm(samples):
    """通过自相关脉冲与峰值间距投票估计 BPM，拒绝缺少稳定鼓击的片段。"""
    onset = drum_onsets(samples)
    if len(onset) < 800 or max(onset, default=0) < 0.08:
        return None
    threshold = max(0.04, max(onset) * 0.18, statistics.mean(onset) * 2)
    peaks = []
    for index in range(2, len(onset) - 2):
        if onset[index] < threshold or onset[index] != max(onset[index - 2:index + 3]):
            continue
        if peaks and index - peaks[-1] < 18:
            if onset[index] > onset[peaks[-1]]:
                peaks[-1] = index
        else:
            peaks.append(index)
    if len(peaks) < 12:
        return None
    bpm = bpm_from_pulse(onset, peaks)
    if bpm:
        return bpm
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
    pairs = [(round((index - anchor) / frame_period), index) for index in matched]
    mean_x = statistics.mean(beat for beat, _ in pairs)
    mean_y = statistics.mean(frame for _, frame in pairs)
    variance = sum((beat - mean_x) ** 2 for beat, _ in pairs)
    if not variance:
        return None
    frame_period = sum((beat - mean_x) * (frame - mean_y) for beat, frame in pairs) / variance
    phase = (mean_y - frame_period * mean_x) * BEAT_FRAME
    residual = max(abs(frame * BEAT_FRAME - (phase + beat * frame_period * BEAT_FRAME)) for beat, frame in pairs)
    if residual > BEAT_RESIDUAL_MAX:
        return None
    period = frame_period * BEAT_FRAME
    return 60 / period if 70.0 <= 60 / period <= 180.0 else None


_FFT_TABLES = {}


def fft(values):
    """原地 radix-2 FFT；调性分析只看幅度。"""
    size = len(values)
    table = _FFT_TABLES.get(size)
    if table is None:
        table = [complex(math.cos(-2 * math.pi * index / size), math.sin(-2 * math.pi * index / size))
                 for index in range(size // 2)]
        _FFT_TABLES[size] = table
    reversed_index = 0
    for index in range(1, size):
        bit = size >> 1
        while reversed_index & bit:
            reversed_index ^= bit
            bit >>= 1
        reversed_index |= bit
        if index < reversed_index:
            values[index], values[reversed_index] = values[reversed_index], values[index]
    length = 2
    while length <= size:
        half = length >> 1
        for start in range(0, size, length):
            for offset in range(half):
                weight = table[offset * (size // length)]
                even = values[start + offset]
                odd = values[start + offset + half] * weight
                values[start + offset] = even + odd
                values[start + offset + half] = even - odd
        length <<= 1


def chroma_vector(samples):
    """把一段采样折成 12 音级的色度向量（55–2000 Hz 上的谱能量）；太短返回 None。"""
    size = KEY_FRAME
    if len(samples) < size * 2:
        return None
    window = [0.5 - 0.5 * math.cos(2 * math.pi * index / size) for index in range(size)]
    hop = max(1, (len(samples) - size) // max(1, KEY_FRAMES - 1))
    step = SAMPLE_RATE / size
    low = max(1, round(KEY_MIN_HZ / step))
    high = min(size // 2 - 1, round(KEY_MAX_HZ / step))
    chroma = [0.0] * 12
    for start in range(0, len(samples) - size + 1, hop):
        frame = [complex(samples[start + index] * window[index], 0.0) for index in range(size)]
        fft(frame)
        for index in range(low, high + 1):
            frequency = index * step
            midi = 69 + 12 * math.log2(frequency / 440.0)
            chroma[round(midi) % 12] += abs(frame[index]) / math.sqrt(frequency)
    return chroma


def camelot_key(tonic, minor):
    """音级转 Camelot 轮盘编号：A 小调 = 8A，C 大调 = 8B。"""
    relative = tonic - (9 if minor else 0)
    return f"{(relative * 7 % 12 + 7) % 12 + 1}{'A' if minor else 'B'}"


def key_estimate(samples):
    """估计调性：色度向量与 Krumhansl 画像做相关，返回 Camelot 编号、音级和置信度。"""
    chroma = chroma_vector(samples)
    total = sum(chroma) if chroma else 0.0
    if not total:
        return None
    chroma = [value / total for value in chroma]
    centered = [value - 1 / 12 for value in chroma]
    spread = math.sqrt(sum(value * value for value in centered))
    if spread <= 1e-9:
        return None
    scores = []
    for minor, profile in KEY_PROFILES.items():
        mean = sum(profile) / 12
        shape = [value - mean for value in profile]
        weight = math.sqrt(sum(value * value for value in shape))
        for tonic in range(12):
            rotated = shape[12 - tonic:] + shape[:12 - tonic]
            scores.append((sum(centered[index] * rotated[index] for index in range(12)) / spread / weight, tonic, minor))
    scores.sort(key=lambda item: item[0], reverse=True)
    (best, tonic, minor), runner_up = scores[0], scores[1][0]
    return {"key": camelot_key(tonic, minor), "tonic": tonic, "minor": minor,
            "confidence": round(max(0.0, min(1.0, (best - runner_up) * 8)), 3)}


def track_features(samples):
    """歌单排序用的单曲特征：BPM、能量、调性；样本太短或无效返回 None。"""
    if samples is None or len(samples) < SAMPLE_RATE * ANALYZE_MIN_SECONDS:
        return None
    bpm = estimate_bpm(samples)
    file_key = key_estimate(samples)
    return {"bpm": round(bpm, 2) if bpm else None,
            "energy": round(math.sqrt(sum(value * value for value in samples) / len(samples)), 4),
            "key": file_key["key"] if file_key else None,
            "keyConfidence": file_key["confidence"] if file_key else None}


def sample_track(url, environment, seconds=ANALYZE_WINDOW):
    """用 ffmpeg 解一段开头的音频做歌单分析；缺 ffmpeg 或读取失败返回 None。"""
    executable = shutil.which("ffmpeg", path=environment.get("PATH"))
    if not executable:
        return None
    headers = "".join(f"{key}: {value}\r\n" for key, value in audio_headers(url).items())
    command = [executable, "-nostdin", "-v", "error", "-rw_timeout", "4000000",
               "-headers", headers, "-i", url, "-t", str(seconds),
               "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
    try:
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=environment, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    values = array.array("f")
    values.frombytes(completed.stdout[:len(completed.stdout) // 4 * 4])
    if sys.byteorder != "little":
        values.byteswap()
    return values
