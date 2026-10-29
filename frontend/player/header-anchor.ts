/** 全局导航栏是挂载资格，位置和搜索文字只用于在导航栏内部排序。 */
export const HEADER_ANCHOR_SCRIPT = `
  const headerSearchInputs = () => Array.from(document.querySelectorAll?.('input') || []).filter(input => {
    if (!input.closest?.('#page_pc_main_nav, .m-top, #g-topbar')) return false;
    const rect = input.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(input) : null;
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  }).sort((left, right) => {
    const score = input => {
      const rect = input.getBoundingClientRect();
      const hint = ['placeholder', 'aria-label', 'type'].map(name => input.getAttribute?.(name) || '').join(' ');
      const search = /搜索|search|搜/i.test(hint) || input.closest?.('.m-srch, [class*="SearchWrapper_"]');
      return (search ? 100000 : 0) + Math.min(rect.width, 600) * 10 - rect.left;
    };
    return score(right) - score(left);
  });
`;
