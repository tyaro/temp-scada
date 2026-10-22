<script lang="ts" module>
  export type ContextAction = {
    label: string;
    disabled?: boolean;
    run: () => void;
  };
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { Menu, MenuGroup, MenuItem } from "@banto/ui";
  let {
    label,
    contextKey,
    items,
    children,
    floating = false,
    flat = false,
  }: {
    label: string;
    contextKey: string;
    items: ContextAction[];
    children?: Snippet;
    floating?: boolean;
    flat?: boolean;
  } = $props();
  let root = $state<HTMLDivElement>();
  let menuButton = $state<HTMLButtonElement>();
  let origin: HTMLElement | null = null;
  let openedKey = "";
  function popup() {
    return root?.querySelector<HTMLElement>("[popover]");
  }
  $effect(() => {
    contextKey;
    const element = root;
    if (element) popup()?.matches(":popover-open") && popup()?.hidePopover();
  });
  let anchor = $state({ x: 0, y: 0 });
  export async function show(
    opener: HTMLElement,
    point?: { x: number; y: number },
  ) {
    const key = contextKey;
    const rect = opener.getBoundingClientRect();
    const menu = popup();
    if (menu?.matches(":popover-open")) menu.hidePopover();
    if (menu && menuButton?.getAttribute("aria-expanded") === "true") {
      await new Promise<void>((resolve) =>
        menu.addEventListener("toggle", () => resolve(), { once: true }),
      );
    }
    anchor = point ?? { x: rect.left, y: rect.bottom };
    await tick();
    // Let native toggle finish before Banto's next trigger activation.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (
      key !== contextKey ||
      !opener.isConnected ||
      !opener.getClientRects().length
    )
      return;
    origin = opener;
    menuButton?.focus({ preventScroll: true });
    menuButton?.click();
  }
  function manage(element: HTMLDivElement) {
    function target(event: Event) {
      const node = event.target;
      if (
        !(node instanceof Element) ||
        node.closest("input,textarea,select,[contenteditable],[role=menu]")
      )
        return null;
      const button = node.closest<HTMLButtonElement>("button");
      return button && element.contains(button) ? button : null;
    }
    function open(event: Event) {
      const button = target(event);
      if (!button) return;
      event.preventDefault();
      origin = button;
      if (popup()?.matches(":popover-open")) return;
      menuButton?.focus({ preventScroll: true });
      menuButton?.click();
    }
    function keyboard(event: KeyboardEvent) {
      if (
        !event.isComposing &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      )
        open(event);
    }
    async function closed(event: Event) {
      if (
        event.target !== popup() ||
        (event as ToggleEvent).newState !== "closed"
      )
        return;
      const previous = origin;
      origin = null;
      await tick();
      // Banto restores its trigger first; return to the actual right-click/keyboard origin.
      if (
        document.activeElement === menuButton ||
        document.activeElement === document.body
      ) {
        if (previous?.isConnected && previous.getClientRects().length)
          previous.focus({ preventScroll: true });
        else if (floating)
          document
            .querySelector<HTMLButtonElement>("[data-permanent-menu]")
            ?.focus();
      }
    }
    function constrain() {
      if (!floating) return;
      requestAnimationFrame(() => {
        const menu = popup();
        if (!menu?.matches(":popover-open")) return;
        const rect = menu.getBoundingClientRect();
        menu.style.top = `${Math.max(4, Math.min(rect.top, document.documentElement.clientHeight - rect.height - 4))}px`;
      });
    }
    function opened(event: Event) {
      if (
        event.target === popup() &&
        (event as ToggleEvent).newState === "open"
      )
        constrain();
    }
    window.addEventListener("resize", constrain);
    element.addEventListener("toggle", opened, true);
    element.addEventListener("contextmenu", open);
    element.addEventListener("keydown", keyboard);
    element.addEventListener("toggle", closed, true);
    return {
      destroy() {
        window.removeEventListener("resize", constrain);
        element.removeEventListener("toggle", opened, true);
        element.removeEventListener("contextmenu", open);
        element.removeEventListener("keydown", keyboard);
        element.removeEventListener("toggle", closed, true);
      },
    };
  }
</script>

<div
  class="context-anchor"
  class:flat
  class:floating
  style:left={floating ? `${anchor.x}px` : undefined}
  style:top={floating ? `${anchor.y}px` : undefined}
  bind:this={root}
  use:manage
>
  {@render children?.()}
  <!-- 対象切替で項目の登録順と表示順がずれないよう、Menuの寿命もcontextに合わせる。 -->
  {#key contextKey}
    <Menu label={`${label} の操作`} placement="bottom-start">
      {#snippet trigger(props)}
        <button
          {...props}
          bind:this={menuButton}
          type="button"
          tabindex={floating ? -1 : 0}
          aria-hidden={floating ? true : undefined}
          class="more"
          aria-label={`操作：${label}`}
          title={`${label} の操作`}
          onclick={(event) => {
            openedKey = contextKey;
            props.onclick(event);
          }}
          onkeydown={(event) => {
            openedKey = contextKey;
            props.onkeydown(event);
          }}>⋮</button
        >
      {/snippet}
      <MenuGroup {label}>
        <!-- Banto navigates in MenuItem mount order. Reuse positions to keep
             that registration order aligned with the DOM within this context. -->
        {#each items as item}
          <MenuItem
            label={item.label}
            disabled={item.disabled}
            onSelect={() => {
              if (openedKey !== contextKey) return;
              // Give overlays a visible opener before they capture focus for restoration.
              const opener = origin ?? menuButton;
              if (opener?.isConnected && opener.getClientRects().length)
                opener.focus({ preventScroll: true });
              item.run();
            }}
          />
        {/each}
      </MenuGroup>
    </Menu>
  {/key}
</div>

<style>
  .context-anchor {
    position: relative;
    min-width: 0;
  }
  .floating {
    position: fixed;
    width: 0;
    height: 0;
  }
  .floating .more {
    width: 1px;
    height: 1px;
    min-height: 0;
    padding: 0;
    right: auto;
    opacity: 0 !important;
    pointer-events: none;
  }
  .floating :global([popover]) {
    max-height: calc(100dvh - 8px);
    overflow-y: auto;
  }
  .more {
    position: absolute;
    right: 0;
    top: 0;
    width: 18px;
    min-height: 20px;
    padding: 0;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
    font-size: 16px;
    cursor: pointer;
    opacity: 0;
  }
  .context-anchor:hover .more,
  .context-anchor:focus-within .more {
    opacity: 1;
  }
  .flat .more {
    border: 0;
    background: transparent;
    top: 4px;
    right: 2px;
    width: 22px;
    min-height: 28px;
  }
  .more:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  @media (hover: none) {
    .more {
      opacity: 1;
    }
  }
</style>
