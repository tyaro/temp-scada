import { tick } from "svelte";
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function controls(form: HTMLFormElement): Control[] {
  return [...form.elements].filter(
    (element): element is Control =>
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      (element instanceof HTMLInputElement &&
        !["button", "submit", "reset", "file"].includes(element.type)),
  );
}
function signature(form: HTMLFormElement): string {
  return JSON.stringify(
    [...new FormData(form)].map(([key, value]) => [key, String(value)]),
  );
}
/** 入力の保護だけを担当する。Project の適用と検証は既存 submit/command 経路へ戻す。 */
export function createDraftGuard(
  onError: (message: string) => void,
  validate: (forms: HTMLFormElement[]) => boolean,
  reveal: (form: HTMLFormElement) => void = () => {},
) {
  // DOM の登録・解除は Svelte の teardown 内でも発生する。
  // レジストリの実体は通常の Set に置き、古い reactive snapshot から入力状態を復活させない。
  const dirty = new Set<HTMLFormElement>();
  let dirtyCount = $state(0);
  let pending = $state<(() => void) | null>(null);
  let applying = false;
  const registry = new Map<
    HTMLFormElement,
    { reset: () => void; restore: () => void }
  >();
  function track(form: HTMLFormElement) {
    let baseline = signature(form);
    let saved = controls(form).map((element) => ({
      element,
      value: element.value,
      checked: element instanceof HTMLInputElement ? element.checked : false,
    }));
    function reset() {
      baseline = signature(form);
      saved = controls(form).map((element) => ({
        element,
        value: element.value,
        checked: element instanceof HTMLInputElement ? element.checked : false,
      }));
      dirty.delete(form);
      dirtyCount = dirty.size;
    }
    function restore() {
      for (const { element, value, checked } of saved) {
        element.value = value;
        if (element instanceof HTMLInputElement) element.checked = checked;
      }
      reset();
    }
    function change() {
      const changed = signature(form) !== baseline;
      if (changed) dirty.add(form);
      else dirty.delete(form);
      dirtyCount = dirty.size;
    }
    registry.set(form, { reset, restore });
    form.addEventListener("input", change);
    form.addEventListener("change", change);
    return {
      destroy() {
        form.removeEventListener("input", change);
        form.removeEventListener("change", change);
        registry.delete(form);
        dirty.delete(form);
        dirtyCount = dirty.size;
      },
    };
  }
  function allow(action: () => void): boolean {
    if (applying) return true;
    if (pending) return false;
    if (!dirty.size) return true;
    pending = action;
    return false;
  }
  function beforeSubmit(form: HTMLFormElement): boolean {
    if (applying) return true;
    if (pending) return false;
    if ([...dirty].some((item) => item !== form)) {
      pending = () => {};
      return false;
    }
    return true;
  }
  async function apply() {
    const action = pending;
    if (!action) return;
    const forms = [...dirty];
    pending = null;
    await tick();
    const invalid = forms.find(
      (form) => form.isConnected && !form.checkValidity(),
    );
    if (invalid) {
      onError("入力に不正な値があります。修正してから操作してください。");
      reveal(invalid);
      await tick();
      invalid.reportValidity();
      return;
    }
    if (!validate(forms)) return;
    applying = true;
    try {
      for (const form of forms) {
        if (!form.isConnected) continue;
        form.requestSubmit();
        if (dirty.has(form)) {
          reveal(form);
          await tick();
          controls(form)[0]?.focus();
          return;
        }
      }
    } finally {
      applying = false;
    }
    await tick();
    action();
  }
  async function discard() {
    const action = pending;
    if (!action) return;
    for (const form of [...dirty]) registry.get(form)?.restore();
    pending = null;
    await tick();
    action();
  }
  return {
    track,
    allow,
    beforeSubmit,
    submitted: (form: HTMLFormElement) => registry.get(form)?.reset(),
    apply,
    discard,
    cancel: () => (pending = null),
    get pending() {
      return pending !== null;
    },
    get count() {
      return dirtyCount;
    },
    get dirty() {
      return dirtyCount > 0;
    },
  };
}
