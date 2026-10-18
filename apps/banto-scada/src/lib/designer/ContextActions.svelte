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
  import { settleMenuFocus } from "./settle-menu-focus";
  let {
    label,
    contextKey,
    items,
    children,
  }: {
    label: string;
    contextKey: string;
    items: ContextAction[];
    children: Snippet;
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
        previous?.isConnected &&
        previous.getClientRects().length &&
        (document.activeElement === menuButton ||
          document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true });
    }
    element.addEventListener("contextmenu", open);
    element.addEventListener("keydown", keyboard);
    element.addEventListener("toggle", closed, true);
    return {
      destroy() {
        element.removeEventListener("contextmenu", open);
        element.removeEventListener("keydown", keyboard);
        element.removeEventListener("toggle", closed, true);
      },
    };
  }
</script>

<div class="context-anchor" bind:this={root} use:manage use:settleMenuFocus>
  {@render children()}
  <Menu label={`${label} の操作`} placement="bottom-start">
    {#snippet trigger(props)}
      <button
        {...props}
        bind:this={menuButton}
        type="button"
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
      {#each items as item (item.label)}
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
</div>

<style>
  .context-anchor {
    position: relative;
    min-width: 0;
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
