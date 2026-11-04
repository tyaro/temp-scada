// Rust model transcripts only; no browser registry or receiver state machine.
import raw from "../../../../../examples/recording-workflow-renewal-cases.json";
import { patched } from "./recording-admission-cases";
import type { ModelDocumentRecipe } from "./recording-registry-model-cases";
export const workflowRenewalFixtures = raw as {
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
export function workflowRenewalDocument(recipe: ModelDocumentRecipe): any {
  return patched(workflowRenewalFixtures.bases[recipe.base], recipe.patch);
}
export function workflowRenewalTranscripts() {
  return workflowRenewalFixtures.scenarios.flatMap((s) =>
    s.steps.flatMap((step, index) =>
      step.expect.document
        ? [
            {
              name: `${s.name} / ${index}`,
              document: workflowRenewalDocument(step.expect.document),
            },
          ]
        : [],
    ),
  );
}
