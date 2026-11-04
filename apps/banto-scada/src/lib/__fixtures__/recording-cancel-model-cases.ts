// Expected DTOs from Rust simulation; never a browser cancellation authority.
import raw from "../../../../../examples/recording-cancel-model-cases.json";
import { patched } from "./recording-admission-cases";
import type { ModelDocumentRecipe } from "./recording-registry-model-cases";
export const cancelModelFixtures = raw as {
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
export function cancelModelDocument(recipe: ModelDocumentRecipe): any {
  return patched(cancelModelFixtures.bases[recipe.base], recipe.patch);
}
export function cancelModelTranscripts() {
  return cancelModelFixtures.scenarios.flatMap((s) =>
    s.steps.flatMap((step, index) =>
      step.expect.document
        ? [
            {
              name: `${s.name} / ${index}`,
              document: cancelModelDocument(step.expect.document),
            },
          ]
        : [],
    ),
  );
}
