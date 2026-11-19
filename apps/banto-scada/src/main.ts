import { mount } from "svelte";
import { startBanto } from "./bootstrap";
import App from "./App.svelte";

const { authClient, stop } = await startBanto();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stop();
  });
// Several e2e specs patch this branch by its text: keep its shape.
if ("__TAURI_INTERNALS__" in window) {
  const { default: NativeShell } = await import("./native/NativeShell.svelte");
  mount(NativeShell, {
    target: document.getElementById("app")!,
    props: { authClient: authClient! },
  });
} else {
  mount(App, { target: document.getElementById("app")! });
}
