<script lang="ts">
  let { id, guard } = $props();
</script>

<form use:guard.track data-probe={id}>
  <label
    >Memo {id}<input
      name="memo"
      aria-label={`Memo ${id}`}
      value="committed"
    /></label
  >
  <label
    >Number {id}<input
      name="number"
      aria-label={`Number ${id}`}
      value="0"
    /></label
  >
</form>

<style>
  form {
    display: grid;
    gap: 16px;
    padding: 16px;
  }
  label {
    display: grid;
  }
  input {
    padding: 8px;
  }
</style>
