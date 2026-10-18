<script lang="ts" module>
  export type DesignerMenu = {
    label: string;
    items: { label: string; disabled?: boolean; run: () => void }[];
  };
</script>

<script lang="ts">
  import { Menu, MenuItem } from "@banto/ui";
  import { settleMenuFocus } from "./settle-menu-focus";
  let { groups }: { groups: DesignerMenu[] } = $props();
  let root: HTMLDivElement;
  let active = $state(0);

  // Banto owns popup positioning, light dismiss, vertical navigation and Escape.
  // Designer adds the horizontal menubar navigation across those menus.
  function navigate(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const target = event.target as HTMLElement;
    const group = target.closest<HTMLElement>("[data-menu-index]");
    if (!group) return;
    const index = Number(group.dataset.menuIndex);
    const inPopup = !!target.closest('[role="menu"]');
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % groups.length;
    else if (event.key === "ArrowLeft")
      next = (index + groups.length - 1) % groups.length;
    else if (!inPopup && event.key === "Home") next = 0;
    else if (!inPopup && event.key === "End") next = groups.length - 1;
    else return;
    event.preventDefault();
    const popup = group.querySelector<HTMLElement>("[popover]");
    const wasOpen = popup?.matches(":popover-open");
    if (wasOpen) popup?.hidePopover();
    active = next;
    const button = root.querySelector<HTMLButtonElement>(
      `[data-menu-trigger="${next}"]`,
    );
    button?.focus();
    if (wasOpen) button?.click();
  }
</script>

<div
  bind:this={root}
  use:settleMenuFocus
  role="menubar"
  tabindex="-1"
  aria-label="Designer メニューバー"
  onkeydown={navigate}
>
  {#each groups as group, index (group.label)}
    <div role="none" data-menu-index={index}>
      <Menu label={group.label} placement="bottom-start">
        {#snippet trigger(props)}
          <button
            {...props}
            role="menuitem"
            tabindex={active === index ? 0 : -1}
            data-menu-trigger={index}
            onfocus={() => (active = index)}>{group.label}</button
          >
        {/snippet}
        {#each group.items as item}
          <MenuItem
            label={item.label}
            disabled={item.disabled}
            onSelect={item.run}
          />
        {/each}
      </Menu>
    </div>
  {/each}
</div>

<style>
  [role="menubar"] {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px 16px;
    border-bottom: 1px solid var(--banto-border);
    background: var(--banto-surface);
    flex-shrink: 0;
  }
  button {
    font: inherit;
    font-size: 13px;
    padding: 5px 12px;
    border: 0;
    border-radius: 4px;
    color: var(--banto-text);
    background: transparent;
    cursor: pointer;
  }
  button:hover,
  button[aria-expanded="true"] {
    background: var(--banto-surface-hover);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
