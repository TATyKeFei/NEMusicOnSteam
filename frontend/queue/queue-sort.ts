/**
 * 歌单智能排序：在播放栏装一个排序按钮，点按后读取待播列表、批量分析 BPM/调性/
 * 能量，按渐变链重排队列。分析走 mpv 后端的 /analyze，只在 mpv 后端显示入口。
 */
import { QUEUE_TRACKS_SCRIPT, queueApplyScript, queueSortButtonResultScript, queueSortButtonScript, queueSortButtonStatusScript, queueSortButtonUpdateScript, queueUrlsScript } from "./queue-sort-player.ts";
import { orderQueue, type QueueFeature } from "./queue-order.ts";
import type { AnalyzedTrack } from "../playback/external-audio.ts";

export type QueueSortTrack = { id: string; name: string; artist: string; sortable: boolean };
export type QueueAnalyzedTrack = AnalyzedTrack;
export type QueueSortOptions = {
  available: () => boolean;
  analyze: (tracks: { trackId: string; url: string }[]) => Promise<{ tracks: QueueAnalyzedTrack[] }>;
  evaluate: (script: string, options?: { awaitPromise?: boolean }) => Promise<unknown>;
};

// 单次请求分析几首、一次取多少条地址：批太小会让长队列等很久，太大又容易超时。
export const QUEUE_SORT_CHUNK = 6;
export const QUEUE_SORT_URL_BATCH = 24;

export class QueueSortBridge {
  private timer = 0;
  private generation = 0;
  private busy = false;
  private sorting = false;
  private installed = false;
  private readonly options: QueueSortOptions;

  constructor(options: QueueSortOptions) {
    this.options = options;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === Boolean(this.timer)) return;
    this.generation++;
    this.installed = false;
    this.sorting = false;
    if (enabled) {
      this.timer = window.setInterval((): void => void this.tick(), 1500);
      void this.tick();
    } else {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const available = this.options.available();
      const script = available && this.installed ? queueSortButtonUpdateScript(true) : queueSortButtonScript(available);
      const result = await this.options.evaluate(script, { awaitPromise: true }) as { installed?: boolean; action?: string | null } | null;
      if (generation !== this.generation) return;
      this.installed = result?.installed === true;
      if (result?.action === "sort" && !this.sorting) {
        this.sorting = true;
        const task = this.runSort(generation);
        void task.finally(() => {
          if (generation === this.generation) this.sorting = false;
        });
      }
    } catch {
      if (generation === this.generation) this.installed = false;
    } finally {
      this.busy = false;
    }
  }

  private async runSort(generation: number): Promise<void> {
    const alive = (): boolean => generation === this.generation;
    try {
      const page = await this.options.evaluate(QUEUE_TRACKS_SCRIPT, { awaitPromise: true }) as {
        ok?: boolean; tracks?: QueueSortTrack[]; reason?: string; index?: number; total?: number; wrap?: boolean;
      } | null;
      if (!alive()) return;
      if (!page?.ok) return this.finish(page?.reason ? `没有重排：${page.reason}` : "没有重排：播放列表不可用", alive);
      const tracks = page.tracks ?? [];
      const sortable = tracks.filter(track => track.sortable && track.id);
      if (sortable.length < 2) {
        // 带上排队诊断：数量对不上时用户能直接看出是"排在末尾还没回绕"还是"读到的队列不对"。
        const total = Number(page.total) || 0;
        const position = Number(page.index);
        const where = Number.isInteger(position) && position >= 0
          ? `队列共 ${total} 首，正在播放第 ${position + 1} 首`
          : `队列共 ${total} 首，没找到正在播放的曲目`;
        return this.finish(`待播列表里没有足够的歌曲可以排序（${where}）`, alive);
      }
      const unique = Array.from(new Set(sortable.map(track => track.id)));
      const urls: Record<string, string> = {};
      for (let index = 0; index < unique.length; index += QUEUE_SORT_URL_BATCH) {
        const chunk = unique.slice(index, index + QUEUE_SORT_URL_BATCH);
        const result = await this.options.evaluate(queueUrlsScript(chunk), { awaitPromise: true }) as Record<string, string> | null;
        if (!alive()) return;
        Object.assign(urls, result ?? {});
      }
      const wanted = unique.filter(id => urls[id]);
      if (wanted.length < 2) return this.finish("网易云没有返回这些歌曲的播放地址，暂时无法排序", alive);
      const analyzed: QueueAnalyzedTrack[] = [];
      for (let index = 0; index < wanted.length; index += QUEUE_SORT_CHUNK) {
        const chunk = wanted.slice(index, index + QUEUE_SORT_CHUNK);
        const response = await this.options.analyze(chunk.map(id => ({ trackId: id, url: urls[id] })));
        if (!alive()) return;
        analyzed.push(...(response?.tracks ?? []));
        if (wanted.length > QUEUE_SORT_CHUNK) {
          await this.options.evaluate(queueSortButtonStatusScript(`正在分析播放列表 ${Math.min(index + QUEUE_SORT_CHUNK, wanted.length)}/${wanted.length} 首…`));
          if (!alive()) return;
        }
      }
      const byId = new Map(analyzed.map(item => [item.trackId, item]));
      const features: QueueFeature[] = sortable.map(track => {
        const feature = byId.get(track.id);
        return { id: track.id, bpm: feature?.bpm ?? null, energy: feature?.energy ?? null, key: feature?.key ?? null };
      });
      if (features.filter(feature => feature.bpm != null || feature.key != null).length < 2) {
        return this.finish("没有分析出足够的节奏或调性，暂时无法排序", alive);
      }
      const ordered = orderQueue(features);
      const slots: number[] = [];
      tracks.forEach((track, position) => { if (track.sortable && track.id) slots.push(position); });
      const finalOrder = tracks.map(track => track.id);
      ordered.forEach((id, index) => { finalOrder[slots[index]] = id; });
      const applied = await this.options.evaluate(queueApplyScript(finalOrder, page.wrap === true), { awaitPromise: true }) as { ok?: boolean; count?: number; reason?: string } | null;
      if (!alive()) return;
      if (!applied?.ok) return this.finish(`没有重排：${applied?.reason ?? "播放列表已经变化"}`, alive);
      const unknown = features.filter(feature => feature.bpm == null && feature.key == null).length;
      await this.finish(`已按节奏与调性重排 ${sortable.length} 首待播歌曲${unknown ? `，其中 ${unknown} 首未能分析排在后面` : ""}`, alive);
    } catch (error) {
      if (!alive()) return;
      const message = error instanceof Error ? error.message.split("\n")[0].replace(/^Error: /, "") : String(error);
      await this.finish(`排序失败：${message}`, alive);
    }
  }

  private async finish(message: string, alive: () => boolean): Promise<void> {
    if (!alive()) return;
    await this.options.evaluate(queueSortButtonResultScript(message)).catch(() => {});
  }
}
