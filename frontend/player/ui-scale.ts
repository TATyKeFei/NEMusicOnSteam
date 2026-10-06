/** 在网易云自己的文档上应用缩放，不影响 Steam 的设置页和客户端控件。 */
export function uiScaleScript(scale: number): string {
  return `(() => {
    const value = ${JSON.stringify(scale)};
    const id = 'nemusic-ui-scale';
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.append(style);
    }
    style.textContent = 'html { zoom: ' + value + '; }';
    return value;
  })()`;
}
