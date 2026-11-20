import { describe, expect, it } from "vitest";
import { labelMirror, placementVector } from "./rotation";

type Flip = { flipX?: boolean; flipY?: boolean };
type Placement = Flip & { x: number; y: number; rotation?: number };

/** 文字の 1 単位ベクトルを、文字の打ち消し → 子の配置 → 親の配置の順に送った画面上の線形写像。 */
function screenLinear(child: Placement, parent?: Placement) {
  const mirror = labelMirror(child, parent);
  const apply = (v: { x: number; y: number }) => {
    const cancelled = {
      x: mirror.flipX ? -v.x : v.x,
      y: mirror.flipY ? -v.y : v.y,
    };
    const local = placementVector(child, cancelled);
    return parent ? placementVector(parent, local) : local;
  };
  const ex = apply({ x: 1, y: 0 });
  const ey = apply({ x: 0, y: 1 });
  return {
    det: ex.x * ey.y - ex.y * ey.x,
    angle: (Math.atan2(ex.y, ex.x) * 180) / Math.PI,
    ex,
    ey,
  };
}

const flips: Flip[] = [
  {},
  { flipX: true },
  { flipY: true },
  { flipX: true, flipY: true },
];

describe("labelMirror（#305 面の図形の文字の読める向き）", () => {
  it("画面の直下は自身の反転の軸だけ打ち消す", () => {
    expect(labelMirror({})).toEqual({ flipX: false, flipY: false });
    expect(labelMirror({ flipX: true })).toEqual({ flipX: true, flipY: false });
    expect(labelMirror({ flipY: true })).toEqual({ flipX: false, flipY: true });
    expect(labelMirror({ flipX: true, flipY: true })).toEqual({
      flipX: true,
      flipY: true,
    });
  });

  for (const own of flips)
    for (const parent of flips)
      it(`自身 ${JSON.stringify(own)} × 親 ${JSON.stringify(parent)} は軸ごとに XOR で、文字は正立`, () => {
        const mirror = labelMirror(own, parent);
        expect(mirror).toEqual({
          flipX: (own.flipX === true) !== (parent.flipX === true),
          flipY: (own.flipY === true) !== (parent.flipY === true),
        });
        const linear = screenLinear(
          { x: 0, y: 0, ...own },
          { x: 0, y: 0, ...parent },
        );
        expect(linear.det).toBeGreaterThan(0);
        expect(linear.ex.x).toBeCloseTo(1);
        expect(linear.ex.y).toBeCloseTo(0);
        expect(linear.ey.y).toBeCloseTo(1);
      });

  it("自身 flipX × 親 flipX は打ち消さない（偶数）", () => {
    expect(labelMirror({ flipX: true }, { flipX: true })).toEqual({
      flipX: false,
      flipY: false,
    });
  });

  it("自身 flipX × 親 flipY は両軸を打ち消す", () => {
    expect(labelMirror({ flipX: true }, { flipY: true })).toEqual({
      flipX: true,
      flipY: true,
    });
  });

  it("自身 flipX＋flipY は正立、rotation 180 は逆さま", () => {
    const both = screenLinear({ x: 0, y: 0, flipX: true, flipY: true });
    expect(both.angle).toBeCloseTo(0);
    expect(both.det).toBeGreaterThan(0);
    const turned = screenLinear({ x: 0, y: 0, rotation: 180 });
    expect(Math.abs(turned.angle)).toBeCloseTo(180);
    expect(turned.det).toBeGreaterThan(0);
  });

  it("親 flipX × 子 rotation 30 は画面上で −30° に傾き、鏡でない", () => {
    const linear = screenLinear(
      { x: 0, y: 0, rotation: 30 },
      { x: 0, y: 0, flipX: true },
    );
    expect(labelMirror({ rotation: 30 } as Flip, { flipX: true })).toEqual({
      flipX: true,
      flipY: false,
    });
    expect(linear.angle).toBeCloseTo(-30);
    expect(linear.det).toBeGreaterThan(0);
  });

  it("子に回転と反転があっても、親の反転と合わせて鏡にならない", () => {
    for (const own of flips)
      for (const parent of flips) {
        const linear = screenLinear(
          { x: 0, y: 0, rotation: 30, ...own },
          { x: 0, y: 0, rotation: 15, ...parent },
        );
        expect(linear.det).toBeGreaterThan(0);
      }
  });
});
