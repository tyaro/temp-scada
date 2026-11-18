import { mount } from "svelte";
import "@banto/theme/css";
import "../studio.css";
import { initializeBanto } from "../lib/banto/setup";
import { parseProject } from "../lib/project";
import DemoApp from "./DemoApp.svelte";
import { findDemoSubject, parseDemoAt, parseDemoView } from "./registry";
import { createDemoClock } from "./scenario";

// GitHub Pages のデモの入口。製品の入口（src/main.ts）とは別で、Tauri の host・
// 認証・記録には接続しない。値は筋書きから作る模擬値だけを渡す。
const params = new URLSearchParams(location.search);
const subject = findDemoSubject(params.get("demo"));
if (!subject) location.replace("./index.html");
else {
  document.title = `${subject.title} · Banto SCADA デモ（模擬値）`;
  const [project, scenario] = await Promise.all([
    subject.project(),
    subject.scenario(),
    initializeBanto(),
  ]);
  mount(DemoApp, {
    target: document.getElementById("app")!,
    props: {
      title: subject.title,
      project: parseProject(JSON.stringify(project)),
      scenario,
      clock: createDemoClock(
        scenario,
        parseDemoAt(params.get("at"), scenario.cycleSec),
      ),
      view: parseDemoView(params.get("view")),
    },
  });
}
