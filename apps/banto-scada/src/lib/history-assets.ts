import type { AssetStore } from "./image-assets";
import type { EditHistory } from "./history";
import type { ImageAsset, Project } from "./project";

/** Per-editor reachability index, bounded by the currently retained history.
 * This is not a Project validation cache; history restoration still parses/validates.
 * Keep only snapshot strings and hashes, never Store/Blob/URL/lease objects.
 */
export function createHistoryAssetCollector() {
  let retained = new Map<string, readonly string[]>();
  return (
    assets: readonly Pick<ImageAsset, "sha256">[],
    history: EditHistory,
    store: Pick<AssetStore, "collect">,
  ): void => {
    const hashes = new Set(assets.map((asset) => asset.sha256));
    const next = new Map<string, readonly string[]>();
    for (const snapshot of [...history.past, ...history.future]) {
      const extracted =
        next.get(snapshot) ??
        retained.get(snapshot) ??
        (JSON.parse(snapshot) as Project).assets.map((asset) => asset.sha256);
      next.set(snapshot, extracted);
      for (const hash of extracted) hashes.add(hash);
    }
    // A failed extraction must not collect originals or publish a partial index.
    store.collect(hashes);
    retained = next;
  };
}
