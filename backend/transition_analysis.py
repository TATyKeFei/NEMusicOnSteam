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
SMART_RAMP_SECONDS = 6.0
SMART_RAMP_FRACTION = 0.3
# 收尾还在全力唱时最多混 8 小节，别让两首歌长时间互相盖住；安静尾奏才用满 30 秒。
SMART_BUSY_BARS = 8
SMART_OUTRO_MARGIN = 8.0
SMART_OUTRO_MINIMUM = 6.0
# 响度匹配的增益上限和取样窗口：用旧歌占主导的前段对新歌即将占主导的后段。
SMART_LEVEL_RANGE = (0.6, 1.67)
SMART_LEVEL_FRACTION = 0.3
SMART_LEVEL_FLOOR = 0.02
# 只允许小幅变速：超过这个范围要么听出拉伸痕迹，要么其实是节奏关系另有其拍。
SMART_TEMPO_RANGE = (0.92, 1.08)
# 自相关拍点检测的门限：脉冲相关度、网格占空、匹配峰相对回归线的残差（秒）。
BEAT_CORR_MIN = 0.35
BEAT_OCCUPANCY_MIN = 0.35
BEAT_RESIDUAL_MAX = 0.075
BEAT_TOLERANCE = 4
# 尽力拍点混音（回退方式 force）的门限：范围更宽、判据更松，但网格仍要成梳状。
BEAT_CORR_MIN_FORCE = 0.28
BEAT_OCCUPANCY_MIN_FORCE = 0.22
BEAT_RESIDUAL_MAX_FORCE = 0.10
BEAT_MATCHED_MIN_FORCE = 6
BEAT_BPM_RANGE_FORCE = (60.0, 200.0)
# 简单整数节奏关系：新歌拍数:旧歌拍数，变速系数 = 拍速比 × 新/旧。
# 1:2 / 2:1 就是「两拍对一拍」（DJ 的 half-time 技巧），几乎不变速、拍点依然锁住；
# 3:2、4:3 这类跨拍关系（hemiola）只在尽力模式下尝试，变速幅度同样受 ±8% 限制。
TEMPO_RELATIONS = ((1, 1), (1, 2), (2, 1))
TEMPO_RELATIONS_FORCE = ((1, 1), (1, 2), (2, 1), (3, 2), (4, 3), (2, 3), (3, 4))
# 长前奏的处理：前奏响度达到主歌这个比例才当成“有内容”，从最靠前的拍点起混。
SMART_INTRO_LEVEL = 0.4
SMART_INTRO_BODY = 6.0
# 淡出起点避开人声乐句：300–3.4 kHz 占比高、且音量不低（相对整段）的帧才算“在唱”。
VOCAL_BAND = (300.0, 3400.0)
VOCAL_ACTIVE = 0.62
VOCAL_GATE = 0.1
VOCAL_BUSY_SHARE = 0.6
# 歌单智能排序的特征分析：只看每首开头一段，BPM/能量/调性够用就好。
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


def envelope(raw):
    samples = array.array("f")
    samples.frombytes(raw[:len(raw) // 4 * 4])
    if sys.byteorder != "little":
        samples.byteswap()
    step = int(SAMPLE_RATE * FRAME_SECONDS)
    return [math.sqrt(sum(value * value for value in samples[i:i + step]) / step)
            for i in range(0, len(samples) - step + 1, step)]


def smoothed(frames, width=5):
    """1 秒左右的滑动平均，避免 100 ms 能量帧在鼓点间隙里忽高忽低。"""
    result = []
    for index in range(len(frames)):
        window = frames[max(0, index - width + 1):index + 1]
        result.append(sum(window) / len(window))
    return result


def quiet_tail_seconds(values):
    """结尾安静（尾奏、淡出）有多长；收尾还在全力唱时接近 0。"""
    frames = smoothed(envelope(values.tobytes()))
    if len(frames) < 40:
        return 0.0
    loud = sorted(frames)[int(len(frames) * 0.7):]
    reference = sum(loud) / len(loud)
    if reference <= 0.001:
        return 0.0
    index = len(frames)
    while index > 0 and frames[index - 1] < reference * 0.45:
        index -= 1
    return (len(frames) - index) * FRAME_SECONDS


def segment_rms(values, start, seconds):
    """一段样本的均方根；太短或空返回 0。"""
    first = max(0, round(start * SAMPLE_RATE))
    last = min(len(values), round((start + seconds) * SAMPLE_RATE))
    if last - first < SAMPLE_RATE // 2:
        return 0.0
    return math.sqrt(sum(value * value for value in values[first:last]) / (last - first))


def vocal_activity(values):
    """每个 100 ms 帧返回 (300–3.4 kHz 的 RMS 占比, 帧 RMS)，作为“人声在唱”的粗略代理。

    一阶低漏相减近似带通。占比不受整体音量影响；再配一道相对整段响亮帧的能量
    门限，把噪声底的高占比帧排除掉。拿不准时不猜：只在明显成片“在唱”时才动。
    """
    low = 1 - math.exp(-2 * math.pi * VOCAL_BAND[0] / SAMPLE_RATE)
    high = 1 - math.exp(-2 * math.pi * VOCAL_BAND[1] / SAMPLE_RATE)
    step = round(SAMPLE_RATE * FRAME_SECONDS)
    ratios, levels = [], []
    for start in range(0, len(values) - step + 1, step):
        low_state = high_state = 0.0
        band_energy = total_energy = 0.0
        for sample in values[start:start + step]:
            low_state += low * (sample - low_state)
            high_state += high * (sample - high_state)
            band = high_state - low_state
            band_energy += band * band
            total_energy += sample * sample
        if total_energy > 1e-9:
            ratios.append(math.sqrt(band_energy / total_energy))
            levels.append(math.sqrt(total_energy / step))
        else:
            ratios.append(0.0)
            levels.append(0.0)
    return ratios, levels


def vocal_busy(activity, offset, span=1.3, lead=0.3, share=VOCAL_BUSY_SHARE):
    """判断旧歌在这段窗口里是不是成片唱着的：起点前 0.3 秒到起点后 1 秒。"""
    ratios, levels = activity
    if not ratios:
        return False
    gate = max(1e-4, sorted(levels)[int(len(levels) * 0.9)] * VOCAL_GATE)
    first = max(0, round((offset - lead) / FRAME_SECONDS))
    last = min(len(ratios), round((offset + span - lead) / FRAME_SECONDS))
    frames = [(ratios[index], levels[index]) for index in range(first, last)]
    if len(frames) < 4:
        return False
    active = sum(1 for ratio, level in frames if ratio >= VOCAL_ACTIVE and level >= gate)
    return active >= max(3, round(len(frames) * share))


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


def pulse_period(onset, relaxed=False):
    """自相关找 70–180 BPM（尽力模式 60–200）里最强的脉冲周期和它的相关度，抛物线细化到亚帧精度。"""
    size = len(onset)
    low = max(2, round(60 / (BEAT_BPM_RANGE_FORCE[1] if relaxed else 180) / BEAT_FRAME))
    high = round(60 / (BEAT_BPM_RANGE_FORCE[0] if relaxed else 70) / BEAT_FRAME)
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


def grid_from_pulse(onset, peaks, relaxed=False):
    """按自相关周期铺拍点网格。密八分、摇摆、弱鼓点这些真实音乐不再被峰覆盖率门限挡掉。"""
    frame_period, strength = pulse_period(onset, relaxed)
    corr_min = BEAT_CORR_MIN_FORCE if relaxed else BEAT_CORR_MIN
    matched_min = BEAT_MATCHED_MIN_FORCE if relaxed else 8
    residual_max = BEAT_RESIDUAL_MAX_FORCE if relaxed else BEAT_RESIDUAL_MAX
    occupancy_min = BEAT_OCCUPANCY_MIN_FORCE if relaxed else BEAT_OCCUPANCY_MIN
    bpm_low, bpm_high = BEAT_BPM_RANGE_FORCE if relaxed else (70.0, 180.0)
    if strength < corr_min:
        return None
    anchor = comb_offset(onset, frame_period)
    matched = [index for index in peaks
               if abs((index - anchor + frame_period / 2) % frame_period - frame_period / 2) <= BEAT_TOLERANCE]
    if len(matched) < matched_min:
        return None
    pairs = [(round((index - anchor) / frame_period), index) for index in matched]
    mean_x = statistics.mean(x for x, _ in pairs)
    mean_y = statistics.mean(y for _, y in pairs)
    variance = sum((x - mean_x) ** 2 for x, _ in pairs)
    if not variance:
        return None
    frame_period = sum((x - mean_x) * (y - mean_y) for x, y in pairs) / variance
    phase = (mean_y - frame_period * mean_x) * BEAT_FRAME
    residual = max(abs(y * BEAT_FRAME - (phase + x * frame_period * BEAT_FRAME)) for x, y in pairs)
    period = frame_period * BEAT_FRAME
    slots = max(1, (matched[-1] - matched[0]) / frame_period + 1)
    occupancy = min(1, len(matched) / slots)
    if residual > residual_max or occupancy < occupancy_min or not bpm_low <= 60 / period <= bpm_high:
        return None
    offset = bar_offset(onset, matched, frame_period, anchor)
    bar = (phase + offset * period) % (4 * period) if offset is not None else None
    return {"bpm": 60 / period, "period": period, "phase": phase % period, "bar": bar,
            "first": peaks[0] * BEAT_FRAME, "last": peaks[-1] * BEAT_FRAME,
            "confidence": strength * occupancy}


def beat_grid(samples, force=False):
    """估计局部 BPM/相位/小节头并拒绝缺少稳定鼓击的片段；不猜测调性或和声。

    先用自相关脉冲找拍点（对真实音乐更宽容），拿不准时退回按峰值间距投票的老路径。
    尽力模式会再用放宽范围的门限重试一次自相关路径。
    """
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
    grid = grid_from_pulse(onset, peaks)
    if grid:
        return grid
    if force:
        grid = grid_from_pulse(onset, peaks, True)
        if grid:
            return grid
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
    score_min = 0.45 if force else 0.62
    coverage_min = 0.6 if force else 0.75
    occupancy_min = 0.5 if force else 0.7
    if not best or best[0] < score_min or best[4] < coverage_min or best[5] < occupancy_min:
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
    if residual > (BEAT_RESIDUAL_MAX_FORCE if force else 0.055):
        return None
    period = frame_period * BEAT_FRAME
    bpm_low, bpm_high = BEAT_BPM_RANGE_FORCE if force else (70.0, 180.0)
    if not bpm_low <= 60 / period <= bpm_high:
        return None
    offset = bar_offset(onset, peaks, frame_period, anchor)
    bar = (phase + offset * period) % (4 * period) if offset is not None else None
    return {"bpm": 60 / period, "period": period, "phase": phase % period, "bar": bar,
            "first": peaks[0] * BEAT_FRAME, "last": peaks[-1] * BEAT_FRAME,
            "confidence": best[0]}


def first_grid_point(first, phase, step):
    """phase + k*step 里第一个不早于 first 的点。"""
    return phase + math.ceil((first - phase) / step) * step


def tempo_stretch(ratio, force=False):
    """按两首歌的拍速比选变速系数：优先最接近原速的整数节奏关系，超出可听范围返回 None。

    1:1 就是小幅变速拉齐；1:2 / 2:1 是半速对齐（几乎不变速）；尽力模式再接受
    3:2、4:3 这类小整数跨拍关系，变速幅度依旧限制在同一范围内。
    """
    low, high = SMART_TEMPO_RANGE
    best = None
    for beats, old in (TEMPO_RELATIONS_FORCE if force else TEMPO_RELATIONS):
        stretch = ratio * beats / old
        if not low <= stretch <= high:
            continue
        candidate = (abs(stretch - 1), beats + old, stretch)
        if best is None or candidate[:2] < best[:2]:
            best = candidate
    return best[2] if best else None


def smart_plan(tail_samples, head_samples, tail_start, duration, fallback, force=False):
    """按鼓点对齐两首歌：对齐拍点、把新歌小幅变速拉齐周期，再安排 8–30 秒重叠。"""
    tail, head = beat_grid(tail_samples, force), beat_grid(head_samples, force)
    plan = {**fallback, "mode": "normal", "reason": "unstable-beats"}
    if not tail or not head:
        return plan
    ratio = tail["bpm"] / head["bpm"]
    stretch = tempo_stretch(ratio, force)
    if stretch is None:
        return {**plan, "reason": "tempo-gap"}
    # 有安静的尾奏就从尾奏前一小段开始混；收尾还在全力唱只混 8 小节，避免长时间两首歌打架。
    quiet = quiet_tail_seconds(tail_samples)
    if quiet >= SMART_OUTRO_MINIMUM:
        maximum = min(SMART_MAX_SECONDS, quiet + SMART_OUTRO_MARGIN)
    else:
        maximum = min(SMART_MAX_SECONDS, SMART_BUSY_BARS * 4 * tail["period"])
    maximum = max(SMART_MIN_SECONDS, maximum)
    # 新歌优先从自己的小节头接入（保留前奏最多两秒），没有可靠小节就退回第一拍。
    skip = first_grid_point(head["first"] - 0.05, head["phase"], head["period"])
    bar_aligned = head["bar"] is not None and tail["bar"] is not None
    if bar_aligned:
        skip = first_grid_point(head["first"] - 0.05, head["bar"], 4 * head["period"])
    if skip > 2:
        skip = first_grid_point(head["first"] - 0.05, head["phase"], head["period"])
    if skip > 2:
        # 长前奏有内容时不必回退：让新歌从自己最前面的拍点起播，前奏叠在旧歌收尾上，
        # 鼓点进来时依旧踩着拍。真正静音的前奏混了也没东西可听：保守模式回退，
        # 尽力模式跳过它，直接从第一个拍点开始唱。
        body = segment_rms(head_samples, head["first"], SMART_INTRO_BODY)
        intro = segment_rms(head_samples, 0, head["first"])
        quiet_intro = intro < body * SMART_INTRO_LEVEL
        if body <= 1e-4 or (quiet_intro and not force):
            return {**plan, "reason": "late-intro-beat"}
        if not quiet_intro:
            skip = first_grid_point(-0.05, head["phase"], head["period"])
            if skip < 0:
                skip += head["period"]
    # 旧歌也从拍点（有小节信息就是小节头）开始，长度取 4 拍的整数倍。
    tail_phase = tail_start + (tail["bar"] if bar_aligned else tail["phase"])
    tail_step = 4 * tail["period"] if bar_aligned else tail["period"]
    # 安静的尾奏没有鼓点但旧歌还在收尾，允许顺着安静段把混音排到歌曲真正结束。
    end = min(duration - fallback["trim"], tail_start + tail["last"] + tail["period"] + quiet)
    # 变速后的新歌消耗得比旧歌快 stretch 倍，安排长度时要给它留够余量。
    available = min(end - tail_start, max(0.0, head["last"] - skip) / stretch)
    beats = int(min(maximum, available) / tail["period"]) // 4 * 4
    if beats * tail["period"] < SMART_MIN_SECONDS:
        return {**plan, "reason": "short-beat-window"}
    desired = end - beats * tail["period"]
    start = tail_phase + math.floor((desired - tail_phase) / tail_step) * tail_step
    if start < max(tail_start, tail_start + tail["first"] - 0.05):
        start += 4 * tail["period"]
        beats -= 4
    seconds = beats * tail["period"]
    # 小节对齐最多把起点提前一小节；只要整段混音在歌内就成立，不再按“离结尾 30 秒”二次拒绝。
    if seconds < SMART_MIN_SECONDS or start + seconds > duration:
        return {**plan, "reason": "short-beat-window"}
    # 淡出起点尽量避开唱到一半的人声乐句：顺着拍点往后找一个干净的落点，
    # 最多两小节；找不到就不动，不为它牺牲重叠长度。
    activity = vocal_activity(tail_samples)
    shift = 0
    for candidate in (0, 1, 2):
        if seconds - candidate * tail_step < SMART_MIN_SECONDS:
            break
        if not vocal_busy(activity, start + candidate * tail_step - tail_start):
            shift = candidate
            break
    start += shift * tail_step
    seconds -= shift * tail_step
    # 旧歌占主导的前段与新歌即将占主导的后段做响度匹配，避免换歌瞬间音量跳一下。
    gain = 1.0
    tail_level = segment_rms(tail_samples, start - tail_start, seconds * SMART_LEVEL_FRACTION)
    head_level = segment_rms(head_samples, skip + seconds * stretch * (1 - SMART_LEVEL_FRACTION),
                             seconds * stretch * SMART_LEVEL_FRACTION)
    if tail_level > SMART_LEVEL_FLOOR and head_level > SMART_LEVEL_FLOOR:
        gain = min(SMART_LEVEL_RANGE[1], max(SMART_LEVEL_RANGE[0], tail_level / head_level))
    return {**fallback, "mode": "smart", "reason": "beat-matched", "startAt": round(start, 3),
            "seconds": round(seconds, 3), "skip": round(skip, 3),
            "trim": round(max(0.0, duration - start - seconds), 3),
            "ratio": round(stretch, 4), "ramp": round(min(SMART_RAMP_SECONDS, seconds * SMART_RAMP_FRACTION), 2),
            "gain": round(gain, 3), "vocalShift": round(shift * tail_step, 3),
            "beatPeriod": round(tail["period"], 4), "barAligned": bar_aligned,
            "fromBpm": round(tail["bpm"], 2), "toBpm": round(head["bpm"], 2),
            "confidence": round(min(tail["confidence"], head["confidence"]), 3)}


def fade_timing(plan, position, song_end, margin=0.12):
    """把分析结果翻译成接管这一刻的淡出参数；错过拍点就顺延，接不上就退回普通淡化。"""
    position = max(0.0, float(position or 0.0))
    maximum = max(0.0, float(plan.get("seconds") or 0.0))
    trim = max(0.0, float(plan.get("trim") or 0.0))
    timing = {"start": position, "duration": maximum, "stretch": 1.0, "ramp": 0.0, "waiting": False,
              "gain": 1.0, "smart": False}
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
            "ramp": min(float(plan.get("ramp") or 0.0), duration * 0.5), "waiting": base > position + 0.02,
            "gain": min(2.0, max(0.5, float(plan.get("gain") or 1.0))), "smart": True}


_FFT_TABLES = {}


def fft(values):
    """原地 radix-2 FFT；调性分析只看幅度。"""
    size = len(values)
    table = _FFT_TABLES.get(size)
    if table is None:
        table = [complex(math.cos(-2 * math.pi * index / size), math.sin(-2 * math.pi * index / size))
                 for index in range(size // 2)]
        _FFT_TABLES[size] = table
    j = 0
    for i in range(1, size):
        bit = size >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            values[i], values[j] = values[j], values[i]
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
    grid = beat_grid(samples)
    file_key = key_estimate(samples)
    return {"bpm": round(grid["bpm"], 2) if grid else None,
            "energy": round(segment_rms(samples, 0, len(samples) / SAMPLE_RATE), 4),
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


class TransitionAnalysis:
    def __init__(self, current_url, duration, next_url, maximum, environment, mode="normal", fallback="normal"):
        self.mode = "smart" if mode == "smart" else "normal"
        # 智能分析失败时的回退方式：normal=普通过渡，none=不做混音，force=放宽判定尽力拍点。
        self.fallback = fallback if fallback in ("none", "force") else "normal"
        # 不做混音时从第一刻起就标成 none，网页在分析出结果前也不会被普通淡化接管。
        result_mode = "none" if self.mode == "smart" and self.fallback == "none" else "normal"
        self.result = {"seconds": maximum, "skip": 0, "trim": 0, "analyzed": False,
                       "mode": result_mode, "reason": "analysis-unavailable"}
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
                    plan = smart_plan(*samples, tail_start, duration, plan, force=self.fallback == "force")
                if self.mode == "smart" and self.fallback == "none" and plan.get("mode") == "normal":
                    # 不做混音：分析没给出拍点计划时明确标成 none，前端就不会接管、
                    # 等旧歌自然播完再让新歌从头开始。
                    plan = {**plan, "mode": "none"}
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
