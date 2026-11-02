import sample from "../../../../../examples/trend.project.json";
import cases from "../../../../../examples/trend-placement-cases.json";
export { cases };
export function trendPlacementCase(fixture: {
  ops?: { path: string; value: unknown }[];
  omitTrends?: boolean;
  removeCard?: boolean;
  symbolTrend?: boolean;
  oversize?: boolean;
}): any {
  const project: any = structuredClone(sample);
  for (const op of fixture.ops ?? []) {
    const keys = op.path.slice(1).split("/");
    const last = keys.pop()!;
    const owner = keys.reduce((value, key) => value[key], project);
    owner[last] = structuredClone(op.value);
  }
  if (fixture.removeCard) project.screens[0].objects.pop();
  if (fixture.omitTrends) delete project.trends;
  if (fixture.symbolTrend)
    project.symbols.push({
      id: "0199f000-0000-7000-8000-000000000041",
      name: "禁止Symbol",
      width: 320,
      height: 120,
      folders: [],
      objects: [
        {
          ...project.screens[0].objects[3],
          id: "0199f000-0000-7000-8000-000000000042",
        },
      ],
    });
  if (fixture.oversize) {
    const row = project.trends[0];
    project.trends = Array.from({ length: 128 }, (_, i) => ({
      ...row,
      id: `trend:${i}`,
      name: "😀".repeat(512),
      maxPointsPerSeries: 1000,
      pens: Array.from({ length: 8 }, (_, j) => ({
        id: `pen:${j}`,
        seriesId: `series:${j}`,
        color: "#123456",
        label: "😀".repeat(512),
      })),
    }));
    project.screens[0].objects[3].shape.trendId = "trend:0";
  }
  return project;
}
