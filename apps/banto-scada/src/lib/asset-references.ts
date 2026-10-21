import type { Project } from "./project";

export interface ImageAssetReference {
  assetId: string;
  owner: "screen" | "symbol";
  ownerId: string;
  objectId?: string;
}
/** Saved definitions retain their originals even when unplaced, hidden or locked.
 * This is a reference projection, not a replacement for Project validation.
 */
export function imageAssetReferences(
  project: Pick<Project, "screens" | "symbols">,
): ImageAssetReference[] {
  const references: ImageAssetReference[] = [];
  for (const [owner, owners] of [
    ["screen", project.screens],
    ["symbol", project.symbols],
  ] as const) {
    for (const definition of owners) {
      if (
        owner === "screen" &&
        "backgroundImage" in definition &&
        definition.backgroundImage
      )
        references.push({
          assetId: definition.backgroundImage.assetId,
          owner,
          ownerId: definition.id,
        });
      for (const object of definition.objects)
        if (object.shape.type === "image")
          references.push({
            assetId: object.shape.assetId,
            owner,
            ownerId: definition.id,
            objectId: object.id,
          });
    }
  }
  return references;
}
