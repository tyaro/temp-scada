import { untrack } from "svelte";
import type { EditCommand } from "../../editor";
import type { Screen, SymbolDefinition } from "../../project";
import { unitBounds } from "../../geometric-groups";
import { validateArrayCopy, type ArrayCopySettings } from "../../array-copy";
interface ArrayCopyHost {
  readonly scope: string;
  readonly revision: number;
  readonly blocked: boolean;
  readonly owner: Screen | SymbolDefinition;
  readonly ids: readonly string[];
  transition(run: () => void): void;
  edit(command: EditCommand, onerror: (message: string) => void): boolean;
  stopPlacement(): void;
  report(message: string): void;
}
export function createArrayCopyController(host: ArrayCopyHost) {
  let request = $state<{
    scope: string;
    revision: number;
    ids: string[];
    stepX: number;
    stepY: number;
  } | null>(null);
  $effect(() => {
    if (
      request &&
      (request.scope !== host.scope ||
        request.revision !== host.revision ||
        host.blocked)
    )
      request = null;
  });
  function open() {
    if (host.blocked || !host.ids.length) return;
    const scope = host.scope;
    host.transition(() => {
      if (host.blocked || host.scope !== scope || !host.ids.length) return;
      const ids = [...host.ids],
        objects = host.owner.objects.filter((object) =>
          ids.includes(object.id),
        );
      try {
        const bounds = unitBounds(objects);
        host.stopPlacement();
        request = {
          scope,
          revision: host.revision,
          ids,
          stepX: bounds.width + 20,
          stepY: bounds.height + 20,
        };
      } catch (error) {
        host.report(
          error instanceof Error
            ? error.message
            : "配列の複製元を確認してください",
        );
      }
    });
  }
  function apply(settings: ArrayCopySettings): string | null {
    const current = untrack(() => request);
    if (
      !current ||
      current.scope !== host.scope ||
      current.revision !== host.revision ||
      host.blocked
    ) {
      request = null;
      return "複製元が変更されました。選択して開き直してください";
    }
    try {
      validateArrayCopy(
        settings,
        current.ids.length,
        host.owner.objects.length,
        "background" in host.owner ? 1000 : 100,
      );
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "配列の設定を確認してください";
    }
    let message = "配列を複製できませんでした";
    const success = host.edit(
      {
        type: "duplicate-array",
        screenId: host.owner.id,
        objectIds: [...current.ids],
        ...settings,
      },
      (error) => {
        message = error;
      },
    );
    if (success) {
      request = null;
      return null;
    }
    return message;
  }
  return {
    get request() {
      return request;
    },
    open,
    apply,
    close: () => {
      request = null;
    },
  };
}
