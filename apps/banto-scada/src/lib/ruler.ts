/** Visible ruler ticks in design units; independent of Project and snap grid. */
export function rulerTicks(length: number, origin: number, scale: number) {
  if (
    !Number.isFinite(length) ||
    length <= 0 ||
    !Number.isFinite(origin) ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    return [];
  const target = 64 / scale;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const major = [1, 2, 5, 10]
    .map((n) => n * magnitude)
    .find((n) => n >= target)!;
  const divisions = (major * scale) / 10 >= 6 ? 10 : 5;
  const step = major / divisions;
  const first = Math.ceil(-origin / scale / step);
  const last = Math.floor((length - origin) / scale / step);
  const ticks: { value: number; position: number; label: string | null }[] = [];
  for (let index = first; index <= last && ticks.length < 2000; index++) {
    const value = Number((index * step).toPrecision(12));
    const large = index % divisions === 0;
    ticks.push({
      value: Object.is(value, -0) ? 0 : value,
      position: origin + value * scale,
      label: large ? String(Object.is(value, -0) ? 0 : value) : null,
    });
  }
  return ticks;
}
