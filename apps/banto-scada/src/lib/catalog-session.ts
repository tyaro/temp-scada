import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-runtime/schema/catalog-view.schema.json";
import { parseProject, type Project } from "./project";
import { sampleCatalog, type TagCatalog } from "./designer/tag-catalog";

export interface CatalogView {
  projectId: string;
  projectRevision: number;
  catalogRevision: number;
  runId: number | null;
  collectionMode: "configured" | "all_simulation";
  tags: {
    externalName: string;
    connection: string;
    group: string;
    name: string;
    dataType: string;
    unit: string | null;
    enabled: boolean;
  }[];
}
export interface CatalogSelection {
  catalog: TagCatalog;
  available: boolean;
  notice: string;
  isCurrent(): boolean;
}
export const sampleSelection: CatalogSelection = {
  catalog: sampleCatalog,
  available: true,
  notice:
    "サンプル候補・Hub未接続。実在や接続成功は未確認です。型の互換性はサンプル定義による判定です。",
  isCurrent: () => true,
};
const empty: TagCatalog = Object.freeze({
  revision: "unavailable",
  groups: Object.freeze([]),
  tags: Object.freeze([]),
});
const validate = new Ajv2020({ strictNumbers: true }).compile<CatalogView>(
  schema,
);

function projectCatalog(view: CatalogView): TagCatalog {
  const groups = new Map<
    string,
    { id: string; parentId?: string; name: string }
  >();
  const tags = view.tags.map((row) => {
    const connection = JSON.stringify([row.connection]);
    const group = JSON.stringify([row.connection, row.group]);
    groups.set(
      connection,
      Object.freeze({ id: connection, name: row.connection }),
    );
    groups.set(
      group,
      Object.freeze({ id: group, parentId: connection, name: row.group }),
    );
    return Object.freeze({
      id: row.externalName,
      groupId: group,
      name: row.name,
      externalName: row.externalName,
      type: row.dataType,
      ...(row.unit === null ? {} : { unit: row.unit }),
      enabled: row.enabled,
      description: row.enabled ? "catalog取得時点の定義" : "無効タグ・割付不可",
    });
  });
  return Object.freeze({
    revision: JSON.stringify([
      view.catalogRevision,
      view.runId,
      view.collectionMode,
    ]),
    groups: Object.freeze([...groups.values()]),
    tags: Object.freeze(tags),
  });
}

/** One local request owns one reply. Payloads cannot start a new request. */
export function createCatalogSession(project: Project) {
  const snapshot = parseProject(JSON.stringify(project));
  let token = Object.freeze({});
  let publication = Object.freeze({});
  let catalog = empty;
  let phase: "loading" | "ready" | "invalid" | "disconnected" = "disconnected";
  function clear(next: typeof phase) {
    catalog = empty;
    phase = next;
    publication = Object.freeze({});
  }
  return {
    begin() {
      token = Object.freeze({});
      clear("loading");
      return token;
    },
    end(delivery: object, invalid = false) {
      if (delivery !== token) return false;
      token = Object.freeze({});
      clear(invalid ? "invalid" : "disconnected");
      return true;
    },
    receive(delivery: object, payload: unknown) {
      if (delivery !== token || phase !== "loading") return false;
      try {
        const owned: unknown = structuredClone(payload);
        if (
          !validate(owned) ||
          owned.projectId !== snapshot.manifest.projectId ||
          owned.projectRevision !== snapshot.manifest.projectRevision
        )
          throw Error("catalogが不正です");
        if (
          new Set(owned.tags.map((row) => row.externalName)).size !==
          owned.tags.length
        )
          throw Error("外部名が重複しています");
        catalog = projectCatalog(owned);
        phase = "ready";
        publication = Object.freeze({});
        return true;
      } catch {
        clear("invalid");
        return false;
      }
    },
    selection(owner: Project): CatalogSelection {
      const issued = publication;
      const current = () =>
        owner === project &&
        owner.manifest.projectId === snapshot.manifest.projectId &&
        owner.manifest.projectRevision === snapshot.manifest.projectRevision &&
        issued === publication;
      const available = current() && phase === "ready";
      return {
        catalog: available ? catalog : empty,
        available,
        notice: available
          ? "タグ一覧の取得時点の候補です。現在値は取得していません。"
          : phase === "loading" && current()
            ? "タグ一覧を取得中です。"
            : phase === "invalid" && current()
              ? "タグ一覧を確認できません。入力は保持しています。"
              : "タグ一覧は未接続です。入力は保持しています。",
        isCurrent: () => current() && phase === "ready",
      };
    },
  };
}
