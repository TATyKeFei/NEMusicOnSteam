export const PANEL_STYLE = `
.nemusic-now-playing {
  box-sizing: border-box; width: 368px; padding: 18px;
  background: #20232b; color: #f1f2f5; border: 1px solid #42454f; border-radius: 8px;
  box-shadow: 0 12px 40px #0009; font: 13px/1.5 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
  -webkit-app-region: no-drag; user-select: none;
}
.nemusic-now-playing * { box-sizing: border-box; }
.nemusic-now-playing button { appearance: none; font: inherit; color: inherit; cursor: pointer; }
.nemusic-now-playing button:disabled { opacity: .35; cursor: default; }
.nemusic-now-playing :focus-visible { outline: 2px solid #ff6979; outline-offset: 3px; }
.nemusic-now-playing .np-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.nemusic-now-playing .np-brand { display: flex; align-items: center; gap: 7px; color: #acafba; font-size: 12px; letter-spacing: 1px; }
.nemusic-now-playing .np-brand svg { width: 18px; height: 18px; color: #ff4c66; }
.nemusic-now-playing .np-icon { border: 0; padding: 5px; width: 30px; height: 30px; background: transparent; display: grid; place-items: center; border-radius: 4px; }
.nemusic-now-playing .np-icon:hover { background: #ffffff12; }
.nemusic-now-playing .np-icon svg { width: 18px; height: 18px; }
.nemusic-now-playing .np-song { display: flex; gap: 16px; align-items: center; min-width: 0; }
.nemusic-now-playing .np-cover { position: relative; flex: 0 0 88px; width: 88px; height: 88px; overflow: hidden; border-radius: 6px; background: linear-gradient(135deg, #4e3040, #29242f); display: grid; place-items: center; box-shadow: 0 4px 15px #0004; }
.nemusic-now-playing .np-cover > span { width: 42px; height: 42px; color: #ef788a; }
.nemusic-now-playing .np-cover svg { width: 100%; height: 100%; }
.nemusic-now-playing .np-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.nemusic-now-playing .np-info { min-width: 0; flex: 1; }
.nemusic-now-playing .np-title { margin: 0 0 6px; font-size: 18px; line-height: 1.4; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nemusic-now-playing .np-artist, .nemusic-now-playing .np-album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b9bbc7; }
.nemusic-now-playing .np-album { font-size: 12px; color: #858895; margin-top: 3px; }
.nemusic-now-playing .np-status { color: #f38c9b; font-size: 11px; margin-top: 7px; }
.nemusic-now-playing .np-lyrics { position: relative; height: 190px; overflow: auto; overscroll-behavior: contain; margin: 18px 0 16px; padding: 72px 8px; border-top: 1px solid #ffffff0a; border-bottom: 1px solid #ffffff0a; scrollbar-width: thin; scrollbar-color: #4a4c57 transparent; text-align: center; }
.nemusic-now-playing .np-line { margin: 0; min-height: 30px; padding: 6px 0; line-height: 1.6; color: #8f929f; transition: color .15s; }
.nemusic-now-playing .np-line[data-active="true"] { color: #fff; font-weight: 600; }
.nemusic-now-playing .np-line small { display: block; color: #8f929f; font-size: 12px; font-weight: 400; }
.nemusic-now-playing .np-line[data-active="true"] small { color: #f098a5; }
.nemusic-now-playing .np-lyrics-message { margin: 0; color: #8f929f; white-space: pre-line; }
.nemusic-now-playing .np-progress { width: 100%; margin: 0; height: 16px; appearance: none; background: transparent; cursor: pointer; accent-color: #ff405d; }
.nemusic-now-playing .np-progress::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: linear-gradient(to right, #ff405d var(--np-progress), #474a55 var(--np-progress)); }
.nemusic-now-playing .np-progress::-webkit-slider-thumb { appearance: none; width: 10px; height: 10px; margin-top: -3.5px; background: #fff; border-radius: 50%; }
.nemusic-now-playing .np-progress::-moz-range-track { height: 3px; border-radius: 2px; background: #474a55; }
.nemusic-now-playing .np-progress::-moz-range-progress { height: 3px; border-radius: 2px; background: #ff405d; }
.nemusic-now-playing .np-progress::-moz-range-thumb { width: 10px; height: 10px; border: 0; background: #fff; border-radius: 50%; }
.nemusic-now-playing .np-progress:disabled { opacity: .4; cursor: default; }
.nemusic-now-playing .np-times { display: flex; justify-content: space-between; color: #9396a3; font-size: 11px; font-variant-numeric: tabular-nums; margin: 0 0 12px; }
.nemusic-now-playing .np-transport { display: flex; justify-content: center; align-items: center; gap: 26px; }
.nemusic-now-playing .np-transport > button { width: 36px; height: 36px; border: 0; background: transparent; display: grid; place-items: center; border-radius: 50%; }
.nemusic-now-playing .np-transport > button:hover:not(:disabled) { background: #ffffff12; }
.nemusic-now-playing .np-transport svg { width: 21px; height: 21px; }
.nemusic-now-playing .np-transport > .np-play { width: 46px; height: 46px; background: #ee3654; color: #fff; }
.nemusic-now-playing .np-transport > .np-play:hover:not(:disabled) { background: #ff4a68; }
.nemusic-now-playing .np-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; padding-top: 12px; border-top: 1px solid #ffffff0a; color: #818592; font-size: 11px; }
.nemusic-now-playing .np-open { background: transparent; border: 0; padding: 0; color: #bfc2cc; font-size: 12px; }
.nemusic-now-playing .np-open:hover { color: #fff; }
.nemusic-now-playing .np-error { margin: 10px 0 0; color: #ffa1ae; font-size: 12px; }
@media (max-height: 580px) { .nemusic-now-playing .np-lyrics { height: 130px; padding-top: 45px; padding-bottom: 45px; } }
`;
