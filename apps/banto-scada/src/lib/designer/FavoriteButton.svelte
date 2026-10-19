<script lang="ts">
  let {
    active,
    label,
    ontoggle,
  }: { active: boolean; label: string; ontoggle: () => void } = $props();
</script>

<button
  class="favorite-star"
  class:chosen={active}
  type="button"
  aria-label={`${label} をお気に入り${active ? "から外す" : "に追加"}`}
  aria-pressed={active}
  title={active ? "お気に入りから外す" : "お気に入りに追加"}
  onclick={ontoggle}
  ><span aria-hidden="true">{active ? "★" : "☆"}</span></button
>

<style>
  button {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text-muted);
    font-size: 15px;
    cursor: pointer;
    opacity: 0;
  }
  button.chosen,
  button:focus-visible,
  :global(.context-anchor:hover) > button,
  :global(.context-anchor:focus-within) > button {
    opacity: 1;
  }
  button.chosen {
    color: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  @media (hover: none) {
    button {
      opacity: 1;
    }
  }
</style>
