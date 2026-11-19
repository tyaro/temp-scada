import { mount } from "svelte";
import { startBanto } from "./bootstrap";

// The Runtime window's entry (Runtime mode design §6-5). It never imports
// App.svelte (Editor): no Editor screen or route is in this bundle.
const { authClient, stop } = await startBanto();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stop();
  });
const target = document.getElementById("app")!;
if (authClient) {
  const { default: RuntimeShell } =
    await import("./native/runtime/RuntimeShell.svelte");
  mount(RuntimeShell, { target, props: { authClient } });
} else {
  target.textContent = "Runtime はデスクトップ版でだけ使えます。";
}
