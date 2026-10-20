/** Temporary Banto 6.7 adapter: bounded Designer menus keep their own scroll open.
 * Install before mounting Banto Menu so this capture boundary precedes its ancestor-scroll close.
 */
const menus = new Map<HTMLElement, HTMLElement>();
function constrain(popup: HTMLElement, trigger: HTMLElement) {
  const box = trigger.getBoundingClientRect(),
    height = document.documentElement.clientHeight,
    below = height - Math.max(0, box.bottom) - 8,
    above = Math.min(height, box.top) - 8;
  popup.style.boxSizing = "border-box";
  popup.style.maxHeight = `${Math.max(0, Math.floor(Math.max(below, above)))}px`;
  popup.style.maxWidth = "min(320px, calc(100vw - 8px))";
  popup.style.overflowY = "auto";
  popup.style.overscrollBehaviorY = "contain";
}
export function registerMenuViewport(popup: HTMLElement, trigger: HTMLElement) {
  menus.set(popup, trigger);
  constrain(popup, trigger);
}
export function unregisterMenuViewport(popup: HTMLElement) {
  menus.delete(popup);
}
export function installDesignerMenuViewport() {
  const scroll = (event: Event) => {
    const target = event.target;
    // Only the menu's own scroll. Descendant widgets and outside scrolling retain Banto's behavior.
    if (
      target instanceof HTMLElement &&
      menus.has(target) &&
      target.isConnected &&
      target.matches(":popover-open")
    )
      event.stopImmediatePropagation();
  };
  const resize = () => {
    for (const [popup, trigger] of menus) {
      if (
        popup.isConnected &&
        trigger.isConnected &&
        popup.matches(":popover-open")
      )
        constrain(popup, trigger);
      else menus.delete(popup);
    }
  };
  window.addEventListener("scroll", scroll, true);
  window.addEventListener("resize", resize, true);
  return () => {
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", resize, true);
    menus.clear();
  };
}
