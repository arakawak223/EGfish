// 空中居合い斬りの幾何ユーティリティ
// 「魚画像のbbox」と「スワイプ直線」から、上下2片の clip-path 用ポリゴンを算出する

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SliceResult {
  /** 0..1 局所座標の頂点配列（clip-path: polygon(...) 用） */
  polyA: Pt[];
  polyB: Pt[];
  /** スワイプ方向ベクトル（正規化済み） */
  dir: Pt;
  /** スワイプ法線ベクトル（A側プラス、B側マイナス） */
  normal: Pt;
}

/** 2線分が交差していれば交点、なければ null。両端含む。 */
export function segmentIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

/** 点 p が直線 (s1->s2) のどちら側か。正/負/0(線上)。 */
export function pointSide(p: Pt, s1: Pt, s2: Pt): number {
  return (s2.x - s1.x) * (p.y - s1.y) - (s2.y - s1.y) * (p.x - s1.x);
}

/** 線分 (p1, p2) が rect と交差するか（端点が中にある場合を含む）。 */
export function segmentCrossesRect(p1: Pt, p2: Pt, r: Rect): boolean {
  const inside = (p: Pt) =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (inside(p1) || inside(p2)) return true;
  const tl: Pt = { x: r.x, y: r.y };
  const tr: Pt = { x: r.x + r.w, y: r.y };
  const br: Pt = { x: r.x + r.w, y: r.y + r.h };
  const bl: Pt = { x: r.x, y: r.y + r.h };
  return (
    segmentIntersect(p1, p2, tl, tr) !== null ||
    segmentIntersect(p1, p2, tr, br) !== null ||
    segmentIntersect(p1, p2, br, bl) !== null ||
    segmentIntersect(p1, p2, bl, tl) !== null
  );
}

/**
 * Bbox を直線 (s1, s2) で2分割し、各半分の閉ポリゴンを 0..1 局所座標で返す。
 * 直線が bbox を貫通しない場合は null。
 */
export function splitRectByLine(
  s1: Pt,
  s2: Pt,
  rect: Rect,
): SliceResult | null {
  // bbox 局所座標 (0..1) に正規化
  const toLocal = (p: Pt): Pt => ({
    x: (p.x - rect.x) / rect.w,
    y: (p.y - rect.y) / rect.h,
  });
  const ls1 = toLocal(s1);
  const ls2 = toLocal(s2);

  // 4辺
  const tl: Pt = { x: 0, y: 0 };
  const tr: Pt = { x: 1, y: 0 };
  const br: Pt = { x: 1, y: 1 };
  const bl: Pt = { x: 0, y: 1 };
  const corners = [tl, tr, br, bl];
  const edges: [Pt, Pt][] = [
    [tl, tr],
    [tr, br],
    [br, bl],
    [bl, tl],
  ];

  // 直線（無限長）と各辺の交点を求めるため、十分長い線分を作る
  const dx = ls2.x - ls1.x;
  const dy = ls2.y - ls1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const FAR = 10;
  const farA: Pt = { x: ls1.x - ux * FAR, y: ls1.y - uy * FAR };
  const farB: Pt = { x: ls1.x + ux * FAR, y: ls1.y + uy * FAR };

  // 各コーナー〜次のコーナーを順に走査し、交点があれば挿入。
  // 同時に各点が直線のどちら側かを記録。
  type Marker = { p: Pt; side: number };
  const ring: Marker[] = [];
  const epsSide = 1e-6;
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const sideRaw = pointSide(c, farA, farB);
    const side = Math.abs(sideRaw) < epsSide ? 0 : Math.sign(sideRaw);
    ring.push({ p: c, side });
    const [ea, eb] = edges[i];
    const inter = segmentIntersect(farA, farB, ea, eb);
    if (inter) {
      // 端点重複を避ける
      const last = ring[ring.length - 1];
      if (Math.hypot(inter.x - last.p.x, inter.y - last.p.y) > 1e-4) {
        ring.push({ p: inter, side: 0 });
      }
    }
  }

  // 直線が bbox を貫通したかを確認: 異なる side を含むこと
  const sides = new Set(ring.map((m) => m.side));
  if (!sides.has(1) || !sides.has(-1)) return null;

  const polyA: Pt[] = ring.filter((m) => m.side >= 0).map((m) => m.p);
  const polyB: Pt[] = ring.filter((m) => m.side <= 0).map((m) => m.p);
  if (polyA.length < 3 || polyB.length < 3) return null;

  // 法線（A側 = side > 0 の側）。スワイプ進行方向に対する右手側を A とする。
  // pointSide の符号は (dx_line)*(dy_p) - (dy_line)*(dx_p) なので、
  // 法線 (右手) は (-uy, ux) のとき pointSide が正になる関係を再確認。
  // ここでは「A側へ向かう法線」を計算する。
  // 任意の A 側点を使って正しい向きを決める。
  const sample = polyA.find(
    (p) => Math.abs(pointSide(p, ls1, ls2)) > epsSide,
  );
  let nx = -uy;
  let ny = ux;
  if (sample) {
    // sample が A 側でなくなる場合は反転
    const probe = pointSide(
      { x: sample.x + nx * 0.01, y: sample.y + ny * 0.01 },
      ls1,
      ls2,
    );
    const ref = pointSide(sample, ls1, ls2);
    if (Math.sign(probe) !== Math.sign(ref)) {
      nx = -nx;
      ny = -ny;
    }
  }

  return {
    polyA,
    polyB,
    dir: { x: ux, y: uy },
    normal: { x: nx, y: ny },
  };
}

/** clip-path: polygon(...) 文字列を生成。座標は 0..1 を百分率に変換。 */
export function polygonToClipPath(poly: Pt[]): string {
  return `polygon(${poly
    .map((p) => `${(p.x * 100).toFixed(2)}% ${(p.y * 100).toFixed(2)}%`)
    .join(", ")})`;
}
