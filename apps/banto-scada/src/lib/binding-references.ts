import type { Project } from "./project";
export interface BindingUsage {
  screenId: string;
  screenName: string;
  objectId: string;
  order: number;
  text: string;
}
export interface BindingReference {
  externalName: string;
  usages: BindingUsage[];
}
/** Project から算出する参照索引。ID や名前を変換せず、同じ外部名だけを集約する。 */
export function bindingReferences(project: Project): BindingReference[] {
  const groups = new Map<string, BindingReference>();
  for (const screen of project.screens) {
    for (const object of [...screen.objects].sort(
      (a, b) => a.order - b.order,
    )) {
      if (object.shape.type !== "text" || !object.shape.binding) continue;
      const externalName = object.shape.binding.externalName;
      let group = groups.get(externalName);
      if (!group) {
        group = { externalName, usages: [] };
        groups.set(externalName, group);
      }
      group.usages.push({
        screenId: screen.id,
        screenName: screen.name,
        objectId: object.id,
        order: object.order,
        text: object.shape.text,
      });
    }
  }
  return [...groups.values()];
}
export function searchReferences(
  references: BindingReference[],
  query: string,
): BindingReference[] {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLocaleLowerCase();
  const term = normalize(query.trim());
  if (!term) return references;
  return references.filter(
    (reference) =>
      normalize(reference.externalName).includes(term) ||
      reference.usages.some(
        (usage) =>
          normalize(usage.screenName).includes(term) ||
          normalize(usage.text).includes(term),
      ),
  );
}
