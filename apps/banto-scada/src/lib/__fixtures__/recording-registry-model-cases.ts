// Expected transcripts from the Rust-only registry model. Not a browser registry.
import raw from "../../../../../examples/recording-registry-model-cases.json";
import { patched, type AdmissionPatch } from "./recording-admission-cases";
export interface ModelDocumentRecipe {
  base: string;
  patch?: AdmissionPatch[];
}
export const registryModelFixtures = raw as {
  scope: unknown;
  principal: string;
  bases: Record<string, any>;
  scenarios: {
    name: string;
    limits?: Record<string, number>;
    steps: {
      op: string;
      input?: ModelDocumentRecipe;
      expect: { kind?: string; error?: string; document?: ModelDocumentRecipe };
      fields?: Record<string, number | boolean>;
    }[];
  }[];
};
export function registryModelDocument(recipe: ModelDocumentRecipe): any {
  return patched(registryModelFixtures.bases[recipe.base], recipe.patch);
}
export function registryModelTranscripts() {
  return registryModelFixtures.scenarios.flatMap((s) =>
    s.steps.flatMap((step, index) =>
      step.expect.document
        ? [
            {
              name: `${s.name} / ${index}`,
              document: registryModelDocument(step.expect.document),
            },
          ]
        : [],
    ),
  );
}
