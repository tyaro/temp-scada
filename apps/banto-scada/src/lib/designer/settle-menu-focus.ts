import { registerMenuViewport, unregisterMenuViewport } from "./menu-viewport";
import { tick } from "svelte";

/** Banto 6.7.0 focuses before its popup visibility style has flushed.
 * Retry after that flush; keep Banto's navigation and native light dismiss.
 */
export function settleMenuFocus(root: HTMLElement) {
  const originalStyles = new Map<HTMLElement, string>();
  function beforeToggle(event: Event) {
    const popup = event.target;
    if (
      !(popup instanceof HTMLElement) ||
      !popup.matches('[popover][role="menu"]')
    )
      return;
    if ((event as ToggleEvent).newState !== "open") {
      unregisterMenuViewport(popup);
      return;
    }
    const opener = popup.previousElementSibling;
    if (
      !(opener instanceof HTMLElement) ||
      opener.getAttribute("aria-haspopup") !== "menu"
    )
      return;
    if (!originalStyles.has(popup))
      originalStyles.set(popup, popup.style.cssText);
    registerMenuViewport(popup, opener);
  }
  let trigger: HTMLElement | null = null;
  let last = false;
  function remember(event: Event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const candidate = target.closest<HTMLElement>('[aria-haspopup="menu"]');
    if (!candidate || !root.contains(candidate)) return;
    trigger = candidate;
    last = event instanceof KeyboardEvent && event.key === "ArrowUp";
  }
  async function opened(event: Event) {
    const popup = event.target;
    if (
      !(popup instanceof HTMLElement) ||
      !popup.matches("[popover]:popover-open")
    )
      return;
    const opener = trigger;
    const focusLast = last;
    await tick();
    // The native toggle is captured before Banto's own toggle handler runs.
    // Wait for its visibility update and the popover's first layout as well.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (!popup.isConnected || !popup.matches(":popover-open")) return;
    const active = document.activeElement;
    if (active !== opener && active !== document.body && active !== popup)
      return;
    const items = [
      ...popup.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].filter((item) => item.getAttribute("aria-disabled") !== "true");
    (items[focusLast ? items.length - 1 : 0] ?? popup).focus();
  }
  root.addEventListener("keydown", remember, true);
  root.addEventListener("click", remember, true);
  root.addEventListener("toggle", opened, true);
  root.addEventListener("beforetoggle", beforeToggle, true);
  return {
    destroy() {
      root.removeEventListener("keydown", remember, true);
      root.removeEventListener("click", remember, true);
      root.removeEventListener("toggle", opened, true);
      root.removeEventListener("beforetoggle", beforeToggle, true);
      for (const [popup, style] of originalStyles) {
        unregisterMenuViewport(popup);
        popup.style.cssText = style;
      }
      originalStyles.clear();
    },
  };
}
