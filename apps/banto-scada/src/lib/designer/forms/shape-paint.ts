import type { EditCommand } from "../../editor";
import type { ScreenObject } from "../../project";
import { normalizeGradientAngle } from "../../linear-gradient";
import { parseLineStyle } from "../../line-style";
import { patternFromForm } from "../pattern-fields";
import { parseNumericProperty } from "../numeric-properties";

export interface ShapePaintInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface ShapePaintContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
}
/** Parse a whole form without changing Project, history or the draft registry. */
export function shapePaintCommand(
  input: ShapePaintInput,
  context: ShapePaintContext,
): EditCommand {
  const { data } = input;
  const { selected } = context;
  if (
    !selected ||
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    (selected.shape.type !== "rectangle" && selected.shape.type !== "ellipse")
  )
    throw new Error(
      "塗りと枠線の適用先が変更されています。選択し直してください。",
    );
  const fill = data.get("fillEnabled"),
    stroke = data.get("strokeEnabled");
  if (
    !["true", "false"].includes(String(fill)) ||
    !["true", "false"].includes(String(stroke))
  )
    throw new Error("塗りと枠線の有無を選択してください。");
  const width =
    stroke === "true"
      ? parseNumericProperty(String(data.get("strokeSize") ?? ""))
      : 0;
  if (stroke === "true" && (width <= 0 || width > 64))
    throw new Error("枠線の幅は0より大きく64以下にしてください。");
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: {
      paint: {
        fill: {
          enabled: fill === "true",
          paint: (() => {
            const kind = String(data.get("fillType"));
            if (kind === "solid")
              return {
                type: "solid" as const,
                color: String(data.get("fillColor")),
                alpha:
                  parseNumericProperty(String(data.get("fillAlpha"))) / 100,
              };
            if (kind === "linearGradient")
              return {
                type: "linearGradient" as const,
                angle: normalizeGradientAngle(
                  parseNumericProperty(String(data.get("fillAngle"))),
                ),
                start: {
                  color: String(data.get("fillStartColor")),
                  alpha:
                    parseNumericProperty(String(data.get("fillStartAlpha"))) /
                    100,
                },
                end: {
                  color: String(data.get("fillEndColor")),
                  alpha:
                    parseNumericProperty(String(data.get("fillEndAlpha"))) /
                    100,
                },
              };
            if (kind === "pattern") return patternFromForm(data);
            throw new Error("塗りの種類を選択してください。");
          })(),
        },
        stroke:
          stroke === "true"
            ? {
                color: String(data.get("strokeColor")),
                width: Number(width),
                ...(parseNumericProperty(String(data.get("strokeAlpha"))) ===
                  100 && selected.shape.paint.stroke?.alpha === undefined
                  ? {}
                  : {
                      alpha:
                        parseNumericProperty(String(data.get("strokeAlpha"))) /
                        100,
                    }),
                ...(parseLineStyle(data.get("strokeStyle")) === "solid" &&
                selected.shape.paint.stroke?.lineStyle !== "solid"
                  ? {}
                  : { lineStyle: parseLineStyle(data.get("strokeStyle")) }),
              }
            : null,
      },
    },
  };
}
