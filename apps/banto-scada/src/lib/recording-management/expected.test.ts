import { describe, expect, it } from "vitest";
import fixtures from "../../../../../examples/recording-management-cases.json";
import type { RecordingInspectionResponse } from "../recording-management-contract";
import {
  expectedRevisionsFor,
  expectedRevisionsFrom,
  revisionText,
} from "./expected";

const base = (name: keyof typeof fixtures.bases) =>
  structuredClone(
    fixtures.bases[name],
  ) as unknown as RecordingInspectionResponse;

describe("expectedRevisionsFrom", () => {
  it("takes the applied, current mapping and retention revisions", () => {
    const response = base("active");
    expect(expectedRevisionsFrom(response, 1000)).toEqual({
      target: response.request.context,
      applied: 2,
      mapping: 4,
      retention: 3,
      inspectedAt: 1000,
    });
  });

  it("reports no revision for a DB without an applied plan", () => {
    expect(expectedRevisionsFrom(base("response"), 5)).toMatchObject({
      applied: null,
      mapping: null,
      retention: null,
    });
  });

  it("gives nothing when the DB could not be read", () => {
    expect(expectedRevisionsFrom(base("unavailable"), 5)).toBeUndefined();
  });
});

describe("expectedRevisionsFor", () => {
  const expected = expectedRevisionsFrom(base("active"), 1)!;
  const target = expected.target;

  it("keeps the revisions for the same target, whatever the context ID", () => {
    expect(
      expectedRevisionsFor(expected, { ...target, contextId: "other" }),
    ).toBe(expected);
  });

  it("drops the revisions read for another Project revision or store", () => {
    expect(
      expectedRevisionsFor(expected, {
        ...target,
        projectRevision: target.projectRevision + 1,
      }),
    ).toBeUndefined();
    expect(
      expectedRevisionsFor(expected, { ...target, storeId: "other" }),
    ).toBeUndefined();
    expect(expectedRevisionsFor(expected, undefined)).toBeUndefined();
    expect(expectedRevisionsFor(undefined, target)).toBeUndefined();
  });
});

describe("revisionText", () => {
  it("leaves the field empty for no revision", () => {
    expect(revisionText(null)).toBe("");
    expect(revisionText(7)).toBe("7");
  });
});
