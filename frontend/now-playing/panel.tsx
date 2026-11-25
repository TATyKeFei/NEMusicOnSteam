import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { SETTINGS_ICON } from "../widget/settings-icon.ts";
import { activeLyric, playbackTime } from "./lyrics.ts";
import { NowPlayingSession, type NowPlayingSource, type NowPlayingState } from "./session.ts";
import { PANEL_STYLE } from "./panel-style.ts";

function Icon({ kind }: { kind: "previous" | "next" | "pause" | "play" | "close" }) {
  const paths = {
    previous: "M6 5h2v14H6zM18 5v14l-9-7z", next: "M16 5h2v14h-2zM6 5l9 7-9 7z",
    pause: "M6 5h4v14H6zM14 5h4v14h-4z", play: "M8 4v16l12-8z",
    close: "m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z",
  };
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export function NowPlayingPanel({ player, onClose, onDismiss }: { player: NowPlayingSource; onClose: () => void; onDismiss: () => void }) {
  const [state, setState] = useState<NowPlayingState>({ track: null, lyrics: null, lyricsLoading: false, error: "", lyricsError: "", pending: false });
  const session = useRef<NowPlayingSession | null>(null);
  const [seek, setSeek] = useState<{ trackId: string; position: number } | null>(null);
  const seekValue = useRef<typeof seek>(null);
  const lyricBox = useRef<HTMLDivElement>(null);
  const activeLine = useRef<HTMLParagraphElement>(null);
  const lastScroll = useRef(0);
  const track = state.track;
  const duration = Math.max(0, track?.duration || 0);
  const position = Math.max(0, Math.min(duration, seek?.trackId === track?.trackId ? seek?.position ?? 0 : track?.position || 0));
  const currentLine = activeLyric(state.lyrics?.lines ?? [], position);
  const available = Boolean(track?.active && track.trackId);
  const playing = track?.playbackStatus === "Playing";
  const artUrl = /^https?:\/\//.test(track?.artUrl || "") ? track!.artUrl : "";
  const [failedCover, setFailedCover] = useState("");

  useEffect(() => {
    const current = new NowPlayingSession(player, setState);
    session.current = current;
    current.start();
    const timer = window.setInterval(() => { void current.refresh(); }, 500);
    return () => { window.clearInterval(timer); current.stop(); session.current = null; };
  }, [player]);
  useEffect(() => onDismiss, [onDismiss]);

  useEffect(() => { setSeek(null); seekValue.current = null; lastScroll.current = 0; }, [track?.trackId]);
  useEffect(() => {
    if (Date.now() - lastScroll.current < 4000) return;
    const box = lyricBox.current, line = activeLine.current;
    if (box && line) box.scrollTo({ top: line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2, behavior: "smooth" });
  }, [currentLine, state.lyrics]);

  const commitSeek = () => {
    const value = seekValue.current;
    if (!value) return;
    seekValue.current = null;
    void session.current?.command({ action: "setposition", value: Math.round(value.position * 1_000_000) }, value.trackId);
    setSeek(null);
  };
  const lines = state.lyrics?.lines ?? [];

  return <section className="nemusic-now-playing" role="dialog" aria-label="歌曲面板" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <style>{PANEL_STYLE}</style>
    <header className="np-header">
      <div className="np-brand"><span dangerouslySetInnerHTML={{ __html: SETTINGS_ICON }} />网易云音乐</div>
      <button className="np-icon" title="关闭歌曲面板" aria-label="关闭歌曲面板" onClick={onClose}><Icon kind="close" /></button>
    </header>
    <div className="np-song">
      <div className="np-cover">
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: SETTINGS_ICON }} />
        {artUrl && failedCover !== artUrl && <img src={artUrl} alt="歌曲封面" referrerPolicy="no-referrer" onError={() => setFailedCover(artUrl)} />}
      </div>
      <div className="np-info">
        <h2 className="np-title" title={track?.title}>{track?.title || "还没有播放歌曲"}</h2>
        <div className="np-artist" title={track?.artist}>{track?.artist || "在网易云选择一首喜欢的音乐"}</div>
        {track?.album && <div className="np-album" title={track.album}>{track.album}</div>}
        {available && <div className="np-status">{playing ? "正在播放" : "已暂停"}</div>}
      </div>
    </div>
    <div className="np-lyrics" ref={lyricBox} tabIndex={0} aria-label="歌词" onWheel={() => { lastScroll.current = Date.now(); }} onTouchMove={() => { lastScroll.current = Date.now(); }}>
      {lines.length ? lines.map((line, index) => <p key={`${line.at}:${index}`} className="np-line" data-active={index === currentLine}
        ref={index === currentLine ? activeLine : undefined}>
        {line.text}{line.translation && line.translation !== line.text && <small>{line.translation}</small>}
      </p>) : <p className="np-lyrics-message">{!available ? "让音乐陪你一会儿" : state.lyricsLoading ? "正在加载歌词…"
        : state.lyricsError || (state.lyrics?.instrumental ? "纯音乐，请欣赏" : state.lyrics?.text || "暂无歌词")}</p>}
    </div>
    <input className="np-progress" type="range" min={0} max={duration || 1} step={0.1} value={position}
      disabled={!available || !track?.canSeek || duration <= 0 || state.pending}
      aria-label="播放进度" aria-valuetext={`${playbackTime(position)} / ${playbackTime(duration)}`}
      style={{ "--np-progress": `${duration ? position / duration * 100 : 0}%` } as CSSProperties}
      onChange={event => { if (track?.trackId) {
        seekValue.current = { trackId: track.trackId, position: Number(event.currentTarget.value) };
        setSeek(seekValue.current);
      } }}
      onPointerUp={commitSeek} onPointerCancel={() => { seekValue.current = null; setSeek(null); }} onKeyUp={event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitSeek();
      }} onBlur={commitSeek} />
    <div className="np-times"><span>{playbackTime(position)}</span><span>{playbackTime(duration)}</span></div>
    <div className="np-transport">
      <button title="上一首" aria-label="上一首" disabled={!available || !track?.canGoPrevious || state.pending} onClick={() => { void session.current?.command({ action: "previous" }); }}><Icon kind="previous" /></button>
      <button className="np-play" title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"} disabled={!available || state.pending}
        onClick={() => { void session.current?.command({ action: playing ? "pause" : "play" }); }}><Icon kind={playing ? "pause" : "play"} /></button>
      <button title="下一首" aria-label="下一首" disabled={!available || !track?.canGoNext || state.pending} onClick={() => { void session.current?.command({ action: "next" }); }}><Icon kind="next" /></button>
    </div>
    {state.error && <p className="np-error" role="status">{state.error}</p>}
    <footer className="np-footer"><span>音乐，随时在这里</span><button className="np-open" onClick={() => { onClose(); player.open(); }}>打开网易云 ↗</button></footer>
  </section>;
}
