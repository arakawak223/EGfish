"use client";

// Step 2 プロトタイプ: 高速まな板カット (トトトトン)
// - Step1 で2分割された片身を「柵」と見立て、まな板上で連打により薄切りにする
// - タップ毎に等間隔の縦カット線が左→右に1本ずつ走る (TARGET_CUTS 本)
// - chop.mp3 をピッチ上昇しながら鳴らし、最終タップで clap.mp3 アクセント
// - リズム評価: タップ間隔の標準偏差から ★1〜3 を返す
// - 実写画像/SE 未配置時は赤枠+無音。手描き/合成にはフォールバックしない
//
// Step1 と同様、可変アニメ状態は ref で mutate し、毎フレーム setView でスナップ。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
const FISH_IMG = (s: Species) => `/assets/cooking/fish/${s}.png`;

const SE_CHOP = "/audio/cooking/chop.mp3";
const SE_CLAP = "/audio/cooking/clap.mp3";
const ALL_SE = [SE_CHOP, SE_CLAP];

// ステージ局所座標 (Step1 と同じ)
const STAGE_W = 380;
const STAGE_H = 620;

// 柵 (fillet) の bbox: 中央寄りに横長
const FILLET_W = 300;
const FILLET_H = 70;
const FILLET_X = (STAGE_W - FILLET_W) / 2;
const FILLET_Y = STAGE_H * 0.5;

// まな板 (背景)
const BOARD_X = 24;
const BOARD_Y = STAGE_H * 0.42;
const BOARD_W = STAGE_W - 48;
const BOARD_H = 220;

// パラメータ
const TARGET_CUTS = 6; // 6本のカットで7切れ
const TIME_BUDGET_MS = 3000; // 1タップ目から TIME_BUDGET 内に全タップ
const IDEAL_INTERVAL_MS = 420; // 理想インターバル(参考)
const KNIFE_LIFE = 220; // 包丁の閃き寿命 (ms)
const SHAKE_PER_TAP = 5;
const SHAKE_DECAY = 110;
const PIECE_DROP = 6; // 完了時の各切れ落差 (px)
const PIECE_TILT = 0.06; // 完了時の最大ランダム傾き (rad)

type Phase = "ready" | "chopping" | "done" | "missed";

interface Tap {
  x: number; // 表示位置 (stage 座標)
  t: number; // performance.now()
  rate: number; // chop.mp3 再生レート (記録用)
}

interface KnifeFlash {
  x: number;
  spawned: number;
  life: number;
}

interface Piece {
  // 切れ片の bbox (柵全体共通) + clip-path で水平方向に切り出す
  leftFrac: number;
  rightFrac: number;
  offsetY: number;
  tilt: number;
}

interface ViewState {
  now: number;
  shakeX: number;
  shakeY: number;
  scale: number;
  cuts: number[]; // stage 座標での縦カット線 X
  knife: KnifeFlash | null;
  pieces: Piece[] | null;
  remainingMs: number; // 残り時間 (chopping 中のみ意味あり)
}

const INITIAL_VIEW: ViewState = {
  now: 0,
  shakeX: 0,
  shakeY: 0,
  scale: 1,
  cuts: [],
  knife: null,
  pieces: null,
  remainingMs: TIME_BUDGET_MS,
};

interface Score {
  stars: 1 | 2 | 3;
  totalMs: number;
  stdMs: number;
}

export default function CuttingBoardChop() {
  const [phase, setPhase] = useState<Phase>("ready");
  const [species, setSpecies] = useState<Species>("buri");
  const [imgErr, setImgErr] = useState<Record<Species, boolean>>({
    buri: false,
    suzuki: false,
    maiwashi: false,
    sawara: false,
    konoshiro: false,
  });
  const [audioStatus, setAudioStatus] = useState<{ ok: number; total: number }>(
    { ok: 0, total: ALL_SE.length },
  );
  const [score, setScore] = useState<Score | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);

  // 内部状態 (RAF で mutate)
  const phaseRef = useRef<Phase>("ready");
  const tapsRef = useRef<Tap[]>([]);
  const cutsRef = useRef<number[]>([]);
  const knifeRef = useRef<KnifeFlash | null>(null);
  const piecesRef = useRef<Piece[] | null>(null);
  const shakeAmpRef = useRef(0);
  const startedAtRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);

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

  // SE 実在チェック + プリロード
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

  const reset = useCallback(() => {
    tapsRef.current = [];
    cutsRef.current = [];
    knifeRef.current = null;
    piecesRef.current = null;
    shakeAmpRef.current = 0;
    startedAtRef.current = 0;
    setScore(null);
    phaseRef.current = "ready";
    setPhase("ready");
  }, []);

  // ───────────── 完了処理 ─────────────
  const finalizeCuts = useCallback(() => {
    const taps = tapsRef.current;
    // 切れ片を生成: cuts を昇順にして 0..1 frac に
    const sorted = [...cutsRef.current].sort((a, b) => a - b);
    const fracs: number[] = sorted.map((cx) => (cx - FILLET_X) / FILLET_W);
    const bounds = [0, ...fracs, 1];
    const pieces: Piece[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      pieces.push({
        leftFrac: bounds[i],
        rightFrac: bounds[i + 1],
        offsetY: PIECE_DROP * (0.5 + Math.random() * 0.6),
        tilt: (Math.random() - 0.5) * 2 * PIECE_TILT,
      });
    }
    piecesRef.current = pieces;

    // スコア
    const totalMs = taps.length >= 2 ? taps[taps.length - 1].t - taps[0].t : 0;
    const intervals: number[] = [];
    for (let i = 1; i < taps.length; i++) {
      intervals.push(taps[i].t - taps[i - 1].t);
    }
    const mean =
      intervals.length > 0
        ? intervals.reduce((a, b) => a + b, 0) / intervals.length
        : 0;
    const variance =
      intervals.length > 0
        ? intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length
        : 0;
    const stdMs = Math.sqrt(variance);

    let stars: 1 | 2 | 3 = 1;
    if (stdMs < 70 && totalMs < 2200) stars = 3;
    else if (stdMs < 130 && totalMs < 2800) stars = 2;
    setScore({ stars, totalMs, stdMs });

    phaseRef.current = "done";
    setPhase("done");
    shakeAmpRef.current = Math.max(shakeAmpRef.current, 8);
  }, []);

  // ───────────── タップ処理 ─────────────
  const onChopTap = useCallback(() => {
    unlockCookingAudio();
    const now = performance.now();

    const ph = phaseRef.current;
    if (ph === "ready") {
      tapsRef.current = [];
      cutsRef.current = [];
      piecesRef.current = null;
      startedAtRef.current = now;
      phaseRef.current = "chopping";
      setPhase("chopping");
    } else if (ph !== "chopping") {
      reset();
      return;
    }

    const idx = tapsRef.current.length;
    if (idx >= TARGET_CUTS) return;

    const x = FILLET_X + (FILLET_W * (idx + 1)) / (TARGET_CUTS + 1);
    const rate = 0.92 + idx * 0.04;

    tapsRef.current.push({ x, t: now, rate });
    cutsRef.current.push(x);

    knifeRef.current = { x, spawned: now, life: KNIFE_LIFE };
    shakeAmpRef.current = SHAKE_PER_TAP;

    const isLast = idx + 1 === TARGET_CUTS;
    if (isLast) {
      playCookingSE(SE_CHOP, { volume: 1.0, rate: 1.18 });
      playCookingSE(SE_CLAP, { volume: 0.85 });
      vibrate([28, 14, 36]);
      finalizeCuts();
    } else {
      playCookingSE(SE_CHOP, { volume: 0.85, rate });
      vibrate([16]);
    }
  }, [reset, finalizeCuts]);

  // ───────────── RAF ─────────────
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const prev = lastFrameRef.current || now;
      const dt = Math.min((now - prev) / 1000, 0.033);
      lastFrameRef.current = now;

      // タイムアウト判定
      let remainingMs = TIME_BUDGET_MS;
      if (phaseRef.current === "chopping") {
        const elapsed = now - startedAtRef.current;
        remainingMs = Math.max(0, TIME_BUDGET_MS - elapsed);
        if (remainingMs <= 0 && tapsRef.current.length < TARGET_CUTS) {
          phaseRef.current = "missed";
          setPhase("missed");
          vibrate([10, 50, 10]);
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
      const shakeX = amp > 0 ? (Math.random() - 0.5) * amp * 1.2 : 0;
      const shakeY = amp > 0 ? (Math.random() - 0.5) * amp * 0.6 : 0;

      // ナイフ寿命
      if (knifeRef.current && now - knifeRef.current.spawned > knifeRef.current.life) {
        knifeRef.current = null;
      }

      setView({
        now,
        shakeX,
        shakeY,
        scale: scaleStateRef.current,
        cuts: cutsRef.current.slice(),
        knife: knifeRef.current ? { ...knifeRef.current } : null,
        pieces: piecesRef.current ? piecesRef.current.map((p) => ({ ...p })) : null,
        remainingMs,
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ───────────── ポインタ ─────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      onChopTap();
    },
    [onChopTap],
  );

  const showImg = !imgErr[species];
  const fillPct =
    phase === "chopping"
      ? Math.min(1, (TIME_BUDGET_MS - view.remainingMs) / TIME_BUDGET_MS)
      : 0;
  const tapsCount =
    phase === "chopping" || phase === "done"
      ? Math.min(TARGET_CUTS, view.cuts.length)
      : 0;

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
          Step2: 高速まな板カット (Prototype)
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
              setImgErr((prev) => ({ ...prev, [s]: false }));
              if (phase !== "chopping") reset();
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
            "linear-gradient(180deg, #1f2532 0%, #322a3f 60%, #4a3729 100%)",
          touchAction: "none",
        }}
      >
        <div
          ref={stageDomRef}
          onPointerDown={onPointerDown}
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
            {/* 上方ライト */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: STAGE_W,
                height: STAGE_H,
                background:
                  "radial-gradient(ellipse at 50% 25%, rgba(255,240,210,0.20), transparent 65%)",
                pointerEvents: "none",
              }}
            />

            {/* まな板 */}
            <div
              style={{
                position: "absolute",
                left: BOARD_X,
                top: BOARD_Y,
                width: BOARD_W,
                height: BOARD_H,
                background:
                  "linear-gradient(180deg, #d6a572 0%, #b8814f 55%, #8b5d34 100%)",
                borderRadius: 16,
                boxShadow:
                  "0 10px 22px rgba(0,0,0,0.45), 0 -2px 0 rgba(255,255,255,0.10) inset, 0 -8px 14px rgba(0,0,0,0.30) inset",
              }}
            />
            {/* 板の木目 */}
            <div
              style={{
                position: "absolute",
                left: BOARD_X,
                top: BOARD_Y,
                width: BOARD_W,
                height: BOARD_H,
                borderRadius: 16,
                background:
                  "repeating-linear-gradient(90deg, rgba(85,55,30,0.0) 0 22px, rgba(85,55,30,0.10) 22px 23px)",
                pointerEvents: "none",
              }}
            />

            {/* 床 */}
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

            {/* 柵 (or 切れ片) */}
            {phase !== "done" ? (
              <div
                style={{
                  position: "absolute",
                  left: FILLET_X,
                  top: FILLET_Y,
                  width: FILLET_W,
                  height: FILLET_H,
                  filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.5))",
                }}
              >
                <FilletVisual
                  species={species}
                  imgOk={showImg}
                  onImgError={() =>
                    setImgErr((prev) => ({ ...prev, [species]: true }))
                  }
                />
              </div>
            ) : (
              view.pieces &&
              view.pieces.map((p, i) => {
                const clip = `inset(0 ${((1 - p.rightFrac) * 100).toFixed(2)}% 0 ${(p.leftFrac * 100).toFixed(2)}%)`;
                const cxPct = ((p.leftFrac + p.rightFrac) / 2) * 100;
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: FILLET_X,
                      top: FILLET_Y,
                      width: FILLET_W,
                      height: FILLET_H,
                      transform: `translate(0px, ${p.offsetY}px) rotate(${p.tilt}rad)`,
                      transformOrigin: `${cxPct}% 50%`,
                      clipPath: clip,
                      WebkitClipPath: clip,
                      filter: "drop-shadow(0 4px 5px rgba(0,0,0,0.55))",
                    }}
                  >
                    <FilletVisual
                      species={species}
                      imgOk={showImg}
                      onImgError={() =>
                        setImgErr((prev) => ({ ...prev, [species]: true }))
                      }
                    />
                  </div>
                );
              })
            )}

            {/* カット線 (chopping 中のみ表示。done では切れ目で代替) */}
            {phase !== "done" &&
              view.cuts.map((cx, i) => (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: cx - 1,
                    top: FILLET_Y - 6,
                    width: 2,
                    height: FILLET_H + 12,
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.0) 0%, rgba(255,255,255,0.95) 30%, rgba(255,255,255,0.95) 70%, rgba(255,255,255,0.0) 100%)",
                    boxShadow: "0 0 6px rgba(255,255,255,0.7)",
                    pointerEvents: "none",
                  }}
                />
              ))}

            {/* 包丁の閃光 */}
            {view.knife && (
              <KnifeFlashVisual flash={view.knife} now={view.now} />
            )}

            {/* タイミングバー (chopping 中のみ) */}
            {phase === "chopping" && (
              <div
                style={{
                  position: "absolute",
                  left: BOARD_X,
                  top: BOARD_Y - 18,
                  width: BOARD_W,
                  height: 6,
                  background: "rgba(0,0,0,0.35)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${(1 - fillPct) * 100}%`,
                    height: "100%",
                    background:
                      fillPct > 0.7
                        ? "linear-gradient(90deg, #ef4444, #f59e0b)"
                        : "linear-gradient(90deg, #facc15, #84cc16)",
                    transition: "width 60ms linear",
                  }}
                />
              </div>
            )}

            {/* 進捗ピップス */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: BOARD_Y - 40,
                width: STAGE_W,
                display: "flex",
                justifyContent: "center",
                gap: 6,
                pointerEvents: "none",
              }}
            >
              {Array.from({ length: TARGET_CUTS }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background:
                      i < tapsCount
                        ? "rgba(245,200,80,1)"
                        : "rgba(255,255,255,0.18)",
                    boxShadow:
                      i < tapsCount ? "0 0 6px rgba(245,200,80,0.9)" : "none",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {phase === "ready" && (
          <Hint text="タップ連打で切る！(目安 6回 トトトトン)" />
        )}
        {phase === "missed" && (
          <Hint text="（時間切れ）タップでやり直し" tone="warn" />
        )}
        {phase === "done" && score && (
          <ScoreOverlay score={score} />
        )}
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5 max-w-md w-full px-2">
        <div>
          画像: {imgErr[species] ? "❌ 未配置" : "✅"} (/assets/cooking/fish/
          {species}.png)
        </div>
        <div>
          SE: {audioStatus.ok}/{audioStatus.total} 読み込み済 (chop / clap.mp3)
        </div>
        <div className="text-slate-400">
          目安: {TARGET_CUTS}タップで{TARGET_CUTS + 1}切れ。理想インターバル{IDEAL_INTERVAL_MS}ms / 全{TIME_BUDGET_MS}ms以内
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── サブ ─────────────────────────

function FilletVisual({
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
            "repeating-linear-gradient(45deg, rgba(255,80,80,0.20) 0 8px, rgba(255,80,80,0.06) 8px 16px)",
          border: "2px dashed rgba(255,80,80,0.7)",
          borderRadius: 6,
          color: "#ffd6d6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          fontSize: 10,
          textAlign: "center",
          padding: 4,
          lineHeight: 1.2,
        }}
      >
        <div style={{ fontWeight: 700 }}>📷 画像未配置</div>
        <div style={{ opacity: 0.85, fontSize: 9 }}>
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

function KnifeFlashVisual({
  flash,
  now,
}: {
  flash: KnifeFlash;
  now: number;
}) {
  const age = now - flash.spawned;
  const k = Math.max(0, 1 - age / flash.life);
  if (k <= 0) return null;
  // 上から振り下ろし: y は age に応じて 0→振り下ろし位置 へ
  const dropProgress = Math.min(1, age / 90); // 最初の90msで降ろす
  const knifeBladeH = 90;
  const knifeTopY = FILLET_Y - knifeBladeH * (1 - dropProgress);
  return (
    <>
      {/* 包丁本体 (シンプルなSVG) */}
      <div
        style={{
          position: "absolute",
          left: flash.x - 12,
          top: knifeTopY - 80,
          width: 24,
          height: knifeBladeH + 80,
          pointerEvents: "none",
          opacity: 0.55 + 0.45 * k,
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))",
        }}
      >
        <svg width={24} height={knifeBladeH + 80} viewBox={`0 0 24 ${knifeBladeH + 80}`}>
          {/* 柄 */}
          <rect x={9} y={0} width={6} height={70} rx={2} fill="#1f2937" />
          <rect x={9} y={0} width={6} height={70} rx={2} fill="url(#handle)" />
          {/* 刃 */}
          <polygon
            points={`6,80 18,80 22,${80 + knifeBladeH - 6} 12,${80 + knifeBladeH} 2,${80 + knifeBladeH - 6}`}
            fill="url(#blade)"
            stroke="#0f172a"
            strokeWidth={0.5}
          />
          <defs>
            <linearGradient id="handle" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#27272a" />
              <stop offset="50%" stopColor="#52525b" />
              <stop offset="100%" stopColor="#18181b" />
            </linearGradient>
            <linearGradient id="blade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#cbd5e1" />
              <stop offset="50%" stopColor="#f8fafc" />
              <stop offset="100%" stopColor="#94a3b8" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      {/* 衝撃の閃き */}
      <div
        style={{
          position: "absolute",
          left: flash.x - 30,
          top: FILLET_Y - 4,
          width: 60,
          height: FILLET_H + 8,
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0.85), rgba(255,255,255,0) 60%)",
          opacity: k,
          pointerEvents: "none",
          filter: "blur(2px)",
        }}
      />
    </>
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

function ScoreOverlay({ score }: { score: Score }) {
  const stars = "★".repeat(score.stars) + "☆".repeat(3 - score.stars);
  return (
    <div className="absolute left-1/2 bottom-6 -translate-x-1/2 bg-slate-900/90 text-white px-5 py-3 rounded-2xl shadow-xl pointer-events-none text-center">
      <div className="text-2xl font-bold tracking-widest text-amber-300">
        {stars}
      </div>
      <div className="text-[11px] text-slate-300 mt-1">
        {(score.totalMs / 1000).toFixed(2)}s · 揺らぎ {Math.round(score.stdMs)}ms
      </div>
      <div className="text-[10px] text-slate-400 mt-1">タップでもう一度</div>
    </div>
  );
}
