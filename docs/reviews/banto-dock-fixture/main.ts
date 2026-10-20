import { mount } from "svelte";
import "../banto/packages/theme/src/css/banto.css";
import App from "./App.svelte";
mount(App, { target: document.getElementById("app")! });
