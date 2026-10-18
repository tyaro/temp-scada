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
/** 入力の保護だけを担当する。Project の適用と検証は既存 submit/command 経路へ戻す。 */
export function createDraftGuard(
  onError: (message: string) => void,
  validate: (forms: HTMLFormElement[]) => boolean,
  reveal: (form: HTMLFormElement) => void = () => {},
  beforeAllow: () => boolean = () => true,
) {
  // DOM の登録・解除は Svelte の teardown 内でも発生する。
  // レジストリの実体は通常の Set に置き、古い reactive snapshot から入力状態を復活させない。
  const dirty = new Set<HTMLFormElement>();
  let dirtyCount = $state(0);
  let pending = $state<(() => void) | null>(null);
  let applying = false;
  const registry = new Map<
    HTMLFormElement,
    {
      reset: () => void;
      restore: () => void;
      accept: (control: Control) => void;
    }
  >();
  function track(form: HTMLFormElement, values?: Record<string, string>) {
    const saved = new Map<Control, { value: string; checked: boolean }>();
    const state = (element: Control) => ({
      value: element.value,
      checked: element instanceof HTMLInputElement ? element.checked : false,
    });
    const changed = (element: Control) => {
      const before = saved.get(element);
      const now = state(element);
      return (
        !before || now.value !== before.value || now.checked !== before.checked
      );
    };
    function change() {
      if (controls(form).some(changed)) dirty.add(form);
      else dirty.delete(form);
      dirtyCount = dirty.size;
    }
    function reset() {
      saved.clear();
      for (const element of controls(form)) saved.set(element, state(element));
      change();
    }
    function restore() {
      for (const [element, before] of saved) {
        element.value = before.value;
        element.setCustomValidity("");
        element.removeAttribute("aria-invalid");
        if (element instanceof HTMLInputElement)
          element.checked = before.checked;
      }
      reset();
      form.dispatchEvent(new Event("reset", { bubbles: true }));
    }
    // A controlled form receives committed model values, without replacing dirty strings.
    function update(next?: Record<string, string>) {
      if (!next) return;
      const current = controls(form);
      for (const element of current) {
        const before = saved.get(element);
        const keep = before && changed(element);
        const value = next[element.name];
        if (value === undefined) continue;
        if (!keep) {
          element.value = value;
          element.setCustomValidity("");
          element.removeAttribute("aria-invalid");
        }
        saved.set(element, { value, checked: state(element).checked });
      }
      for (const element of saved.keys())
        if (!current.includes(element)) saved.delete(element);
      change();
    }
    if (values) update(values);
    else reset();
    registry.set(form, {
      reset,
      restore,
      accept(control) {
        if (control.form !== form) return;
        saved.set(control, state(control));
        change();
      },
    });
    form.addEventListener("input", change);
    form.addEventListener("change", change);
    return {
      update,
      destroy() {
        form.removeEventListener("input", change);
        form.removeEventListener("change", change);
        registry.delete(form);
        dirty.delete(form);
        dirtyCount = dirty.size;
      },
    };
  }
  let resolving = false;
  function allow(action: () => void): boolean {
    if (applying) return true;
    if (pending || resolving) return false;
    resolving = true;
    try {
      if (!beforeAllow()) return false;
    } finally {
      resolving = false;
    }
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
    acceptField: (control: Control) => {
      if (control.form) registry.get(control.form)?.accept(control);
    },
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
