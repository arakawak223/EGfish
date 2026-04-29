"use client";

// Step 1 プロトタイプ: 空中居合い斬り
// - 魚は実写プレースホルダ画像を放物線軌道で空中飛行
// - スワイプ軌跡と魚 bbox の交差で「斬撃」を発火
// - clip-path を用いた動的2分割 + 物理(慣性/重力/角速度)で落下
// - 画面シェイク + 閃光 + ハプティクス + 実音源SE
// - 画像/SE未配置時は明示ラベル。決して手描きにフォールバックしない
//
// React 19 のrender純粋性を守るため、アニメに関わる可変状態は
// すべて RAF 内で計算しスナップショットを `view` state に渡す。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Pt,
  polygonToClipPath,
  segmentCrossesRect,
  splitRectByLine,
} from "@/lib/cooking-geometry";
import {
  playCookingSE,
  preloadCookingAudio,
  unlockCookingAudio,
} from "@/lib/cooking-audio";
import { vibrate } from "@/lib/haptics";

type Species = "buri" | "suzuki" | "maiwashi" | "sawara" | "konoshiro";

const SPECIES_LIST: Species[] = [
  "buri",
  "suzuki",
  "maiwashi",
  "sawara",
  "konoshiro",
];
const SPECIES_LABEL: Record<Species, string> = {
  buri: "ブリ",
  suzuki: "スズキ",
  maiwashi: "マイワシ",
  sawara: "サワラ",
  konoshiro: "コノシロ",
};
const SPECIES_SIZE: Record<Species, { w: number; h: number }> = {
  buri: { w: 260, h: 95 },
  suzuki: { w: 230, h: 80 },
  maiwashi: { w: 160, h: 52 },
  sawara: { w: 240, h: 78 },
  konoshiro: { w: 140, h: 55 },
};
const FISH_IMG = (s: Species) => `/assets/cooking/fish/${s}.png`;

const SE_WHOOSH = "/audio/cooking/whoosh.mp3";
const SE_SLASH = "/audio/cooking/slash.mp3";
const SE_LANDING = "/audio/cooking/landing.mp3";
const ALL_SE = [SE_WHOOSH, SE_SLASH, SE_LANDING];

// ステージ局所座標
const STAGE_W = 380;
const STAGE_H = 620;
const BOARD_TOP = STAGE_H - 140;

// 物理パラメータ
const FLIGHT_VY0 = -780;
const FLIGHT_GRAVITY = 980;
const HALF_GRAVITY = 1500;
const SLICE_SEPARATE_SPEED = 320;
const SLICE_LIFT = 220;
const SHAKE_INITIAL = 14;
const SHAKE_DECAY = 90;

const FLASH_LIFE = 260;
const TRAIL_LIFE = 160;

type Phase = "ready" | "flying" | "halves" | "missed" | "done";

interface FishFlight {
  species: Species;
  imgOk: boolean;
  size: { w: number; h: number };
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  angle: number;
  angVel: number;
}

interface Half {
  imgOk: boolean;
  baseX: number;
  baseY: number;
  baseW: number;
  baseH: number;
  offsetX: number;
  offsetY: number;
  vx: number;
  vy: number;
  angle: number;
  angVel: number;
  clipPath: string;
  originX: number;
  originY: number;
}

interface SwipePt {
  x: number;
  y: number;
  t: number;
}

interface SlashFlash {
  from: Pt;
  to: Pt;
  spawned: number;
  life: number;
}

interface ViewState {
  now: number;
  shakeX: number;
  shakeY: number;
  scale: number;
  flight: FishFlight | null;
  halves: [Half, Half] | null;
  trail: SwipePt[];
  flash: SlashFlash | null;
}

const INITIAL_VIEW: ViewState = {
  now: 0,
  shakeX: 0,
  shakeY: 0,
  scale: 1,
  flight: null,
  halves: null,
  trail: [],
  flash: null,
};

export default function AerialSlash() {
  const [phase, setPhase] = useState<Phase>("ready");
  const [species, setSpecies] = useState<Species>("buri");
  const [imgErr, setImgErr] = useState<Record<Species, boolean>>({
    buri: false,
    suzuki: false,
    maiwashi: false,
    sawara: false,
    konoshiro: false,
  });
  const [audioStatus, setAudioStatus] = useState<{
    ok: number;
    total: number;
  }>({ ok: 0, total: ALL_SE.length });

  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  // 内部 sim 状態（RAFで mutate）
  const flightRef = useRef<FishFlight | null>(null);
  const halvesRef = useRef<[Half, Half] | null>(null);
  const trailRef = useRef<SwipePt[]>([]);
  const flashRef = useRef<SlashFlash | null>(null);
  const shakeAmpRef = useRef<number>(0);
  const draggingRef = useRef(false);
  const phaseRef = useRef<Phase>("ready");
  const lastFrameRef = useRef<number>(0);

  // ステージ寸法→scale測定
  const stageDomRef = useRef<HTMLDivElement | null>(null);
  const scaleStateRef = useRef<number>(1);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const el = stageDomRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const next = r.width / STAGE_W;
      if (Math.abs(next - scaleStateRef.current) > 0.001) {
        scaleStateRef.current = next;
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // SE実在チェック + プリロード
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const checks = await Promise.all(
        ALL_SE.map(async (u) => {
          try {
            const r = await fetch(u, { method: "HEAD" });
            return r.ok;
          } catch {
            return false;
          }
        }),
      );
      if (cancelled) return;
      const ok = checks.filter(Boolean).length;
      setAudioStatus({ ok, total: ALL_SE.length });
      const present = ALL_SE.filter((_, i) => checks[i]);
      preloadCookingAudio(present);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resetImgError = useCallback((s: Species) => {
    setImgErr((prev) => ({ ...prev, [s]: false }));
  }, []);

  // ───────────────────────── 飛行開始 ─────────────────────────
  const launch = useCallback(
    (s: Species) => {
      unlockCookingAudio();
      const size = SPECIES_SIZE[s];
      const fromLeft = Math.random() < 0.5;
      const startX = fromLeft ? -size.w / 2 - 20 : STAGE_W + size.w / 2 + 20;
      const startY = STAGE_H * 0.62;
      const vx = fromLeft ? 260 : -260;
      flightRef.current = {
        species: s,
        imgOk: !imgErr[s],
        size,
        cx: startX,
        cy: startY,
        vx,
        vy: FLIGHT_VY0,
        angle: fromLeft ? -0.05 : 0.05,
        angVel: fromLeft ? 0.4 : -0.4,
      };
      halvesRef.current = null;
      flashRef.current = null;
      trailRef.current = [];
      shakeAmpRef.current = 0;
      phaseRef.current = "flying";
      setPhase("flying");
      playCookingSE(SE_WHOOSH, { volume: 0.6 });
    },
    [imgErr],
  );

  // ───────────────────────── 切断処理 ─────────────────────────
  const performCut = useCallback((s1Screen: Pt, s2Screen: Pt) => {
    const f = flightRef.current;
    if (!f) return;

    const bbox = {
      x: f.cx - f.size.w / 2,
      y: f.cy - f.size.h / 2,
      w: f.size.w,
      h: f.size.h,
    };

    const rotateAround = (p: Pt, c: Pt, a: number): Pt => {
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      return {
        x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
        y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
      };
    };
    const center: Pt = { x: f.cx, y: f.cy };
    const s1 = rotateAround(s1Screen, center, -f.angle);
    const s2 = rotateAround(s2Screen, center, -f.angle);

    const sliced = splitRectByLine(s1, s2, bbox);
    if (!sliced) return;

    const centroid = (poly: Pt[]): Pt => {
      let cx = 0;
      let cy = 0;
      for (const p of poly) {
        cx += p.x;
        cy += p.y;
      }
      return { x: cx / poly.length, y: cy / poly.length };
    };
    const cA = centroid(sliced.polyA);
    const cB = centroid(sliced.polyB);

    const rotF = (v: Pt, a: number): Pt => ({
      x: v.x * Math.cos(a) - v.y * Math.sin(a),
      y: v.x * Math.sin(a) + v.y * Math.cos(a),
    });
    const normalWorld = rotF(sliced.normal, f.angle);

    const inheritVx = f.vx * 0.6;
    const inheritVy = f.vy * 0.6;

    const halfA: Half = {
      imgOk: f.imgOk,
      baseX: bbox.x,
      baseY: bbox.y,
      baseW: bbox.w,
      baseH: bbox.h,
      offsetX: 0,
      offsetY: 0,
      vx: inheritVx + normalWorld.x * SLICE_SEPARATE_SPEED,
      vy: inheritVy + normalWorld.y * SLICE_SEPARATE_SPEED - SLICE_LIFT,
      angle: f.angle,
      angVel: 3.5 + Math.random() * 1.5,
      clipPath: polygonToClipPath(sliced.polyA),
      originX: cA.x * 100,
      originY: cA.y * 100,
    };
    const halfB: Half = {
      imgOk: f.imgOk,
      baseX: bbox.x,
      baseY: bbox.y,
      baseW: bbox.w,
      baseH: bbox.h,
      offsetX: 0,
      offsetY: 0,
      vx: inheritVx - normalWorld.x * SLICE_SEPARATE_SPEED,
      vy: inheritVy - normalWorld.y * SLICE_SEPARATE_SPEED - SLICE_LIFT * 0.7,
      angle: f.angle,
      angVel: -3.5 - Math.random() * 1.5,
      clipPath: polygonToClipPath(sliced.polyB),
      originX: cB.x * 100,
      originY: cB.y * 100,
    };
    halvesRef.current = [halfA, halfB];
    flightRef.current = null;

    flashRef.current = {
      from: s1Screen,
      to: s2Screen,
      spawned: performance.now(),
      life: FLASH_LIFE,
    };

    shakeAmpRef.current = SHAKE_INITIAL;

    vibrate([180, 20, 60]);
    playCookingSE(SE_SLASH, { volume: 0.85 });

    phaseRef.current = "halves";
    setPhase("halves");
  }, []);

  // ───────────────────────── RAF ─────────────────────────
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const prev = lastFrameRef.current || now;
      const dt = Math.min((now - prev) / 1000, 0.033);
      lastFrameRef.current = now;

      // 飛行更新
      if (phaseRef.current === "flying") {
        const f = flightRef.current;
        if (f) {
          f.cx += f.vx * dt;
          f.cy += f.vy * dt;
          f.vy += FLIGHT_GRAVITY * dt;
          f.angle += f.angVel * dt;
          const offX = f.cx < -f.size.w || f.cx > STAGE_W + f.size.w;
          const offY = f.cy > STAGE_H + f.size.h;
          if (offX || offY) {
            flightRef.current = null;
            phaseRef.current = "missed";
            setPhase("missed");
          }
        }
      }

      // 半身物理更新
      if (phaseRef.current === "halves") {
        const halves = halvesRef.current;
        if (halves) {
          let allDown = true;
          for (const h of halves) {
            h.offsetX += h.vx * dt;
            h.offsetY += h.vy * dt;
            h.vy += HALF_GRAVITY * dt;
            h.angle += h.angVel * dt;
            h.angVel *= 1 - 0.2 * dt;
            const cy = h.baseY + h.baseH / 2 + h.offsetY;
            if (cy < STAGE_H + h.baseH) allDown = false;
          }
          if (allDown) {
            playCookingSE(SE_LANDING, { volume: 0.7 });
            vibrate([18, 8, 18]);
            phaseRef.current = "done";
            setPhase("done");
          }
        }
      }

      // シェイク減衰
      if (shakeAmpRef.current > 0) {
        shakeAmpRef.current = Math.max(
          0,
          shakeAmpRef.current - SHAKE_DECAY * dt,
        );
      }
      const amp = shakeAmpRef.current;
      const shakeX = amp > 0 ? (Math.random() - 0.5) * amp * 2 : 0;
      const shakeY = amp > 0 ? (Math.random() - 0.5) * amp * 2 : 0;

      // trail 古い点削除
      if (trailRef.current.length > 0) {
        const cutoff = now - TRAIL_LIFE;
        while (
          trailRef.current.length > 0 &&
          trailRef.current[0].t < cutoff
        ) {
          trailRef.current.shift();
        }
      }
      // flash 寿命終了
      if (flashRef.current) {
        const age = now - flashRef.current.spawned;
        if (age > flashRef.current.life) flashRef.current = null;
      }

      // スナップショットを state へ。各フィールドを浅コピー（参照は ref と共有）
      setView({
        now,
        shakeX,
        shakeY,
        scale: scaleStateRef.current,
        flight: flightRef.current
          ? { ...flightRef.current, size: { ...flightRef.current.size } }
          : null,
        halves: halvesRef.current
          ? [{ ...halvesRef.current[0] }, { ...halvesRef.current[1] }]
          : null,
        trail: trailRef.current.slice(),
        flash: flashRef.current ? { ...flashRef.current } : null,
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ───────────────────────── ポインタ ─────────────────────────
  const localPt = useCallback((e: React.PointerEvent): Pt | null => {
    const el = stageDomRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / scaleStateRef.current;
    const sy = (e.clientY - rect.top) / scaleStateRef.current;
    return { x: sx, y: sy };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      unlockCookingAudio();
      const ph = phaseRef.current;
      if (ph === "ready" || ph === "missed" || ph === "done") {
        launch(species);
        return;
      }
      const p = localPt(e);
      if (!p) return;
      draggingRef.current = true;
      trailRef.current = [{ x: p.x, y: p.y, t: performance.now() }];
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [launch, localPt, species],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const p = localPt(e);
      if (!p) return;
      const t = performance.now();
      const arr = trailRef.current;
      const last = arr[arr.length - 1];
      arr.push({ x: p.x, y: p.y, t });
      if (arr.length > 32) arr.shift();

      if (phaseRef.current === "flying" && last) {
        const f = flightRef.current;
        if (!f) return;
        const bbox = {
          x: f.cx - f.size.w / 2,
          y: f.cy - f.size.h / 2,
          w: f.size.w,
          h: f.size.h,
        };
        if (segmentCrossesRect(last, p, bbox)) {
          performCut(last, p);
        }
      }
    },
    [localPt, performCut],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  // ───────────────────────── 描画ヘルパ（state のみ参照）─────────────────────────
  const flightV = view.flight;
  const halvesV = view.halves;

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <header className="w-full flex items-center justify-between max-w-md px-2">
        <Link
          href="/"
          className="text-xs bg-slate-700 text-white px-3 py-1.5 rounded-full active:scale-95"
        >
          ← 戻る
        </Link>
        <span className="text-xs font-bold text-slate-700">
          Step1: 空中居合い斬り (Prototype)
        </span>
        <span className="text-[10px] text-slate-500 w-12 text-right">
          {phase}
        </span>
      </header>

      <div className="flex gap-1 flex-wrap justify-center max-w-md">
        {SPECIES_LIST.map((s) => (
          <button
            key={s}
            onClick={() => {
              setSpecies(s);
              resetImgError(s);
            }}
            className={`text-xs px-3 py-1 rounded-full active:scale-95 ${
              s === species
                ? "bg-amber-500 text-white font-bold"
                : "bg-slate-200 text-slate-700"
            }`}
          >
            {SPECIES_LABEL[s]}
          </button>
        ))}
      </div>

      <div
        className="relative overflow-hidden rounded-xl shadow-lg"
        style={{
          width: "min(calc(100vw - 16px), 480px)",
          aspectRatio: `${STAGE_W} / ${STAGE_H}`,
          background:
            "linear-gradient(180deg, #1b1f2a 0%, #2c2438 60%, #4a3528 100%)",
          touchAction: "none",
        }}
      >
        <div
          ref={stageDomRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate(${view.shakeX}px, ${view.shakeY}px)`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: STAGE_W,
              height: STAGE_H,
              transform: `scale(${view.scale})`,
              transformOrigin: "top left",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: STAGE_W,
                height: STAGE_H,
                background:
                  "radial-gradient(ellipse at 50% 30%, rgba(255,240,200,0.18), transparent 60%)",
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 24,
                top: BOARD_TOP,
                width: STAGE_W - 48,
                height: 110,
                background:
                  "linear-gradient(180deg, #c9986a 0%, #a37348 60%, #7a542f 100%)",
                borderRadius: 12,
                boxShadow: "0 8px 16px rgba(0,0,0,0.4) inset",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: STAGE_H - 30,
                width: STAGE_W,
                height: 30,
                background:
                  "linear-gradient(180deg, #2a1c10 0%, #1a1108 100%)",
              }}
            />

            {phase === "flying" && flightV && (
              <div
                style={{
                  position: "absolute",
                  left: flightV.cx - flightV.size.w / 2,
                  top: flightV.cy - flightV.size.h / 2,
                  width: flightV.size.w,
                  height: flightV.size.h,
                  transform: `rotate(${flightV.angle}rad)`,
                  transformOrigin: "50% 50%",
                  willChange: "transform, left, top",
                  filter: "drop-shadow(0 6px 8px rgba(0,0,0,0.45))",
                }}
              >
                <FishVisual
                  species={flightV.species}
                  imgOk={flightV.imgOk && !imgErr[flightV.species]}
                  onImgError={() =>
                    setImgErr((prev) => ({
                      ...prev,
                      [flightV.species]: true,
                    }))
                  }
                />
              </div>
            )}

            {(phase === "halves" || phase === "done") &&
              halvesV &&
              halvesV.map((h, i) => (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: h.baseX,
                    top: h.baseY,
                    width: h.baseW,
                    height: h.baseH,
                    transform: `translate(${h.offsetX}px, ${h.offsetY}px) rotate(${h.angle}rad)`,
                    transformOrigin: `${h.originX}% ${h.originY}%`,
                    clipPath: h.clipPath,
                    WebkitClipPath: h.clipPath,
                    willChange: "transform",
                    filter:
                      i === 0
                        ? "drop-shadow(0 4px 6px rgba(0,0,0,0.45))"
                        : "drop-shadow(0 6px 10px rgba(0,0,0,0.5))",
                  }}
                >
                  <FishVisual
                    species={species}
                    imgOk={h.imgOk}
                    onImgError={() =>
                      setImgErr((prev) => ({ ...prev, [species]: true }))
                    }
                  />
                </div>
              ))}

            <svg
              width={STAGE_W}
              height={STAGE_H}
              viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: STAGE_W,
                height: STAGE_H,
                pointerEvents: "none",
              }}
            >
              <TrailLines trail={view.trail} now={view.now} />
              <FlashLines flash={view.flash} now={view.now} />
            </svg>
          </div>
        </div>

        {phase === "ready" && (
          <Hint text="タップで魚が空中へ。スワイプで斬る。" />
        )}
        {phase === "missed" && (
          <Hint text="（外し）タップでもう一匹" tone="warn" />
        )}
        {phase === "done" && <Hint text="タップでもう一匹" tone="ok" />}
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5 max-w-md w-full px-2">
        <div>
          画像: {imgErr[species] ? "❌ 未配置" : "✅"} (/assets/cooking/fish/
          {species}.png)
        </div>
        <div>
          SE: {audioStatus.ok}/{audioStatus.total} 読み込み済 (whoosh / slash /
          landing.mp3)
        </div>
        <div className="text-slate-400">
          実写素材を /public/assets/cooking/fish/, /public/audio/cooking/ に配置すると本来のリアル感で動作します。
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── サブ ─────────────────────────

function FishVisual({
  species,
  imgOk,
  onImgError,
}: {
  species: Species;
  imgOk: boolean;
  onImgError: () => void;
}) {
  if (!imgOk) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background:
            "repeating-linear-gradient(45deg, rgba(255,80,80,0.18) 0 8px, rgba(255,80,80,0.06) 8px 16px)",
          border: "2px dashed rgba(255,80,80,0.7)",
          borderRadius: 8,
          color: "#ffd6d6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          fontSize: 11,
          textAlign: "center",
          padding: 4,
          lineHeight: 1.2,
        }}
      >
        <div style={{ fontWeight: 700 }}>📷 画像未配置</div>
        <div style={{ opacity: 0.85 }}>
          /assets/cooking/fish/{species}.png
        </div>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={FISH_IMG(species)}
      alt={SPECIES_LABEL[species]}
      onError={onImgError}
      draggable={false}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        userSelect: "none",
        pointerEvents: "none",
      }}
    />
  );
}

function TrailLines({ trail, now }: { trail: SwipePt[]; now: number }) {
  if (trail.length < 2) return null;
  const segs: React.ReactElement[] = [];
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const age = now - b.t;
    const k = Math.max(0, 1 - age / TRAIL_LIFE);
    if (k <= 0) continue;
    segs.push(
      <line
        key={i}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={`rgba(220, 240, 255, ${0.15 + 0.6 * k})`}
        strokeWidth={2 + 6 * k}
        strokeLinecap="round"
      />,
    );
  }
  return <g>{segs}</g>;
}

function FlashLines({
  flash,
  now,
}: {
  flash: SlashFlash | null;
  now: number;
}) {
  if (!flash) return null;
  const age = now - flash.spawned;
  const k = Math.max(0, 1 - age / flash.life);
  if (k <= 0) return null;
  return (
    <g style={{ pointerEvents: "none" }}>
      <line
        x1={flash.from.x}
        y1={flash.from.y}
        x2={flash.to.x}
        y2={flash.to.y}
        stroke={`rgba(180, 220, 255, ${0.55 * k})`}
        strokeWidth={28 * k}
        strokeLinecap="round"
        style={{ filter: "blur(8px)" }}
      />
      <line
        x1={flash.from.x}
        y1={flash.from.y}
        x2={flash.to.x}
        y2={flash.to.y}
        stroke={`rgba(255,255,255,${0.95 * k})`}
        strokeWidth={4 + 7 * k}
        strokeLinecap="round"
      />
    </g>
  );
}

function Hint({
  text,
  tone = "info",
}: {
  text: string;
  tone?: "info" | "warn" | "ok";
}) {
  const bg =
    tone === "warn"
      ? "bg-rose-500/85"
      : tone === "ok"
        ? "bg-emerald-500/85"
        : "bg-slate-700/85";
  return (
    <div
      className={`absolute left-1/2 bottom-6 -translate-x-1/2 ${bg} text-white text-xs font-bold px-4 py-2 rounded-full shadow-lg pointer-events-none`}
    >
      {text}
    </div>
  );
}
