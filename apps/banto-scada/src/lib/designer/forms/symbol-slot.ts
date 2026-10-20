import type { SymbolCommand } from "../../editor/commands";
import type { Project } from "../../project";
export function symbolSlotFormCommand(
  input: {
    connected: boolean;
    targetKey: string | undefined;
    symbolId: string | undefined;
    slotName: string | undefined;
    action: string | undefined;
    data: Pick<FormData, "get">;
  },
  context: {
    project: Project;
    generation: number;
    definitionId: string | undefined;
  },
): SymbolCommand {
  if (
    !input.connected ||
    !context.definitionId ||
    input.symbolId !== context.definitionId ||
    input.targetKey !== `${context.generation}:${context.definitionId}`
  )
    throw new Error("読取slotの編集対象が変わりました");
  const definition = context.project.symbols.find(
    (item) => item.id === context.definitionId,
  );
  if (!definition) throw new Error("共有定義が見つかりません");
  const name = String(input.data.get("slotName") ?? "");
  const slotType = input.data.get("slotType");
  if (slotType !== "bool" && slotType !== "number")
    throw new Error("読取slotの型を選択してください");
  const fields = {
    symbolId: definition.id,
    name,
    slotType: slotType as "bool" | "number",
  };
  if (input.action === "create") return { type: "add-symbol-slot", ...fields };
  if (
    input.action !== "update" ||
    !definition.readSlots?.some((slot) => slot.name === input.slotName)
  )
    throw new Error("読取slot宣言が見つかりません");
  return { type: "update-symbol-slot", slotName: input.slotName!, ...fields };
}
/** Reset only successful creation; failed edits must keep the user's input. */
export function acknowledgeSymbolSlotForm(form: HTMLFormElement) {
  if (form.dataset.slotAction !== "create") return;
  const name = form.querySelector<HTMLInputElement>('input[name="slotName"]');
  const type = form.querySelector<HTMLSelectElement>('select[name="slotType"]');
  if (name) name.value = "";
  if (type) type.value = "number";
}
