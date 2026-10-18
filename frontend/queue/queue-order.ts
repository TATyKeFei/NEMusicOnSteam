/**
 * 歌单智能排序：把待播队列按 BPM / 调性 / 能量排成渐变链，让相邻两首尽可能
 * 接近，适合连着听。保持列表里第一首已分析歌曲的头部位置不动，缺少特征的
 * 歌按原相对顺序排在最后——排序拿不准时不打乱用户既有的安排。
 */

export type QueueFeature = {
  id: string;
  bpm: number | null;
  energy: number | null;
  // Camelot 轮盘编号，比如 "8B"：数字是轮盘位置，字母 A/B 是小调/大调。
  key: string | null;
};

const BPM_WEIGHT = 1;
const KEY_WEIGHT = 0.3;
const ENERGY_WEIGHT = 0.4;

export function parseCamelot(value: string | null): { position: number; minor: boolean } | null {
  const match = /^(\d{1,2})([AB])$/.exec(String(value ?? "").trim().toUpperCase());
  if (!match) return null;
  const position = Number(match[1]);
  if (!(position >= 1 && position <= 12)) return null;
  return { position, minor: match[2] === "A" };
}

/** Camelot 距离：同位置的大小调可以直换，相邻位置最顺，隔得越远越生硬。 */
function keyCost(left: QueueFeature["key"], right: QueueFeature["key"]): number {
  const from = parseCamelot(left);
  const to = parseCamelot(right);
  if (!from || !to) return 0.8;
  const steps = Math.min(Math.abs(from.position - to.position), 12 - Math.abs(from.position - to.position));
  if (steps === 0) return from.minor === to.minor ? 0 : 0.25;
  return steps + (from.minor === to.minor ? 0 : 0.5);
}

function stepCost(from: QueueFeature, to: QueueFeature): number {
  const tempo = from.bpm && to.bpm ? BPM_WEIGHT * Math.abs(Math.log2(to.bpm / from.bpm)) : 0.5;
  const energy = from.energy != null && to.energy != null ? ENERGY_WEIGHT * Math.abs(to.energy - from.energy) : 0.15;
  return tempo + KEY_WEIGHT * keyCost(from.key, to.key) + energy;
}

function hasFeatures(item: QueueFeature): boolean {
  return item.bpm != null || item.energy != null || item.key != null;
}

/** 返回重排后的 id 序列；重复的 id（同一首歌排了两次）按数量保留。 */
export function orderQueue(items: readonly QueueFeature[]): string[] {
  const original = items.map(item => item.id);
  const known = items.filter(hasFeatures);
  if (known.length < 2) return original;
  // 链头是列表里第一首有特征的歌：用户排的下一首尽量保持靠前，其余按距离续链。
  const anchor = known[0];
  const rest = items.filter(item => item !== anchor && hasFeatures(item));
  const unknown = items.filter(item => !hasFeatures(item));
  const chain: QueueFeature[] = [anchor];
  const remaining = [...rest];
  while (remaining.length > 0) {
    const last = chain[chain.length - 1];
    let best = 0;
    let bestCost = stepCost(last, remaining[0]);
    for (let index = 1; index < remaining.length; index++) {
      const cost = stepCost(last, remaining[index]);
      if (cost < bestCost) {
        best = index;
        bestCost = cost;
      }
    }
    chain.push(remaining.splice(best, 1)[0]);
  }
  return chain.concat(unknown).map(item => item.id);
}
