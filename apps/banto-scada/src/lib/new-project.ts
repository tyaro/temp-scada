import { newId } from "./editor";
import { parseProject, type Project } from "./project";

/** A clean, unsaved baseline; creating another project shares no identifiers. */
export function createProject(): Project {
  return parseProject(
    JSON.stringify({
      manifest: {
        product: "banto-scada",
        schemaVersion: "0.8.0",
        projectId: newId(),
        projectRevision: 1,
        minRuntimeVersion: "0.8.0",
        name: "新しいProject",
      },
      screens: [
        {
          id: newId(),
          name: "画面1",
          width: 960,
          height: 540,
          background: "#ffffff",
          objects: [],
          folders: [],
        },
      ],
      symbols: [],
    }),
  );
}
