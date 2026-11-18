// デモ用 Project を examples/ へ書き出す。
//   node scripts/demo-projects/build.mjs && pnpm exec prettier --write examples/demo-*.project.json
// 生成後は README の検証（cargo run -p scada-model -- validate など）で確かめる。
import { writeFileSync } from "node:fs";
import { waterProject } from "./water.mjs";

const outputs = { "demo-water": waterProject() };
for (const [name, project] of Object.entries(outputs)) {
  const path = new URL(`../../examples/${name}.project.json`, import.meta.url);
  writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`);
  console.log(`wrote examples/${name}.project.json`);
}
