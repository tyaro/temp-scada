// Rust model transcripts only; no browser registry or receiver state machine.
import raw from "../../../../../examples/recording-workflow-model-cases.json";
import { patched } from "./recording-admission-cases";
import type { ModelDocumentRecipe } from "./recording-registry-model-cases";
export const workflowModelFixtures = raw as {
  bases: Record<string, any>;
  scenarios: {
    name: string;
    limits?: Record<string, number>;
    steps: {
      op: string;
      input?: ModelDocumentRecipe;
      expect: { kind?: string; error?: string; document?: ModelDocumentRecipe };
    }[];
  }[];
};
export function workflowModelDocument(recipe: ModelDocumentRecipe): any {
  return patched(workflowModelFixtures.bases[recipe.base], recipe.patch);
}
export function workflowModelTranscripts() {
  return workflowModelFixtures.scenarios.flatMap((s) =>
    s.steps.flatMap((step, index) =>
      step.expect.document
        ? [
            {
              name: `${s.name} / ${index}`,
              document: workflowModelDocument(step.expect.document),
            },
          ]
        : [],
    ),
  );
}
