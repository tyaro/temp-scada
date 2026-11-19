import { mount } from "svelte";
import { startBanto } from "./bootstrap";
import App from "./App.svelte";

const { authClient, stop } = await startBanto();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stop();
  });
if (authClient) {
  const { default: NativeShell } = await import("./native/NativeShell.svelte");
  mount(NativeShell, {
    target: document.getElementById("app")!,
    props: { authClient },
  });
} else {
  mount(App, { target: document.getElementById("app")! });
}
