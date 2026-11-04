// Rust executes the scenarios. Browser code only checks expected DTO transcripts.
import raw from "../../../../../examples/recording-observation-model-cases.json";
import { patched } from "./recording-admission-cases";
import type { ModelDocumentRecipe } from "./recording-registry-model-cases";
export const observationModelFixtures = raw as {
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
export function observationModelDocument(recipe: ModelDocumentRecipe): any {
  return patched(observationModelFixtures.bases[recipe.base], recipe.patch);
}
export function observationModelTranscripts() {
  return observationModelFixtures.scenarios.flatMap((s) =>
    s.steps.flatMap((step, index) =>
      step.expect.document
        ? [
            {
              name: `${s.name} / ${index}`,
              document: observationModelDocument(step.expect.document),
            },
          ]
        : [],
    ),
  );
}
