import type { EditCommand } from "../../editor";

export function projectFormCommand(data: Pick<FormData, "get">): EditCommand {
  return { type: "update-project", name: String(data.get("name")) };
}

export function acknowledgeProjectForm(form: HTMLFormElement, name: string) {
  const input = form.elements.namedItem("name");
  if (input instanceof HTMLInputElement) input.value = name;
}
