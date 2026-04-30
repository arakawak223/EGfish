"use client";

// Step 3 プロトタイプ: リズム握り (ギュッ・ギュッ・ギュッ)
// - シャリの上にネタ(柵から1切れ分の clip-path 切り出し)が乗った状態でスタート
// - 3タップでリズム良く握る。各タップで押し込み→反発のスクイーズアニメ
// - リズム評価: 3拍の間隔標準偏差 + 総時間で ★1〜3
// - SE: nigiri.mp3 (押し込み) + landing.mp3 (置き) + clap.mp3 (締め)
// - ネタ画像未配置時は赤枠+無音 (Step1/2 と同じ規約)
// - シャリは CSS oval (魚と違って主役ではないため合成OK)

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
// 柵から1切れを横に切り出す位置 (Step2 で 1/7 ピース相当)
const NETA_FRAC_LEFT: Record<Species, number> = {
  buri: 0.45,
  suzuki: 0.42,
  maiwashi: 0.4,
  sawara: 0.5,
  konoshiro: 0.4,
};
const NETA_FRAC_W = 1 / 7;
const FISH_IMG = (s: Species) => `/assets/cooking/fish/${s}.png`;

const SE_NIGIRI = "/audio/cooking/nigiri.mp3";
const SE_LANDING = "/audio/cooking/landing.mp3";
const SE_CLAP = "/audio/cooking/clap.mp3";
const ALL_SE = [SE_NIGIRI, SE_LANDING, SE_CLAP];

const STAGE_W = 380;
const STAGE_H = 620;

// 握り中心
const NIGIRI_CX = STAGE_W / 2;
const NIGIRI_CY = STAGE_H * 0.6;
const RICE_W = 200;
const RICE_H = 70;
const NETA_W = 220;
const NETA_H = 44;

// パラメータ
const TARGET_TAPS = 3;
const IDEAL_INTERVAL_MS = 600;
const TIME_BUDGET_MS = 2600;
const SQUEEZE_LIFE = 240; // 1タップ分のスクイーズアニメ寿命 (ms)
const SQUEEZE_AMOUNT = 0.18; // 圧縮深さ (scaleY 0.82)
const SQUEEZE_BOUNCE = 0.07; // 反発時のオーバーシュート
const SHAKE_PER_TAP = 4;
const SHAKE_DECAY = 100;

type Phase = "ready" | "squeezing" | "done" | "missed";

interface Tap {
  t: number;
}

interface SqueezeAnim {
  startedAt: number;
  life: number;
  depth: number;
}

interface ViewState {
  now: number;
  shakeX: number;
  shakeY: number;
  scale: number;
  /** 押し込み量 (-bounce..0..+depth)。正で圧縮、負で反発 */
  pressY: number;
  /** 手の降下進捗 0..1 (1=完全に着地) */
  handProgress: number;
  /** 完了タップ数 */
  squeezesDone: number;
  remainingMs: number;
}

const INITIAL_VIEW: ViewState = {
  now: 0,
  shakeX: 0,
  shakeY: 0,
  scale: 1,
  pressY: 0,
  handProgress: 0,
  squeezesDone: 0,
  remainingMs: TIME_BUDGET_MS,
};

interface Score {
  stars: 1 | 2 | 3;
  totalMs: number;
  stdMs: number;
}

export default function RhythmNigiri() {
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

  const phaseRef = useRef<Phase>("ready");
  const tapsRef = useRef<Tap[]>([]);
  const squeezeRef = useRef<SqueezeAnim | null>(null);
  const startedAtRef = useRef<number>(0);
  const shakeAmpRef = useRef<number>(0);
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
    squeezeRef.current = null;
    startedAtRef.current = 0;
    shakeAmpRef.current = 0;
    setScore(null);
    phaseRef.current = "ready";
    setPhase("ready");
  }, []);

  const finalize = useCallback(() => {
    const taps = tapsRef.current;
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
    if (stdMs < 80 && totalMs < 1700) stars = 3;
    else if (stdMs < 160 && totalMs < 2200) stars = 2;
    setScore({ stars, totalMs, stdMs });

    playCookingSE(SE_LANDING, { volume: 0.7 });
    playCookingSE(SE_CLAP, { volume: 0.6 });
    vibrate([22, 14, 32]);
    phaseRef.current = "done";
    setPhase("done");
  }, []);

  const onSqueezeTap = useCallback(() => {
    unlockCookingAudio();
    const now = performance.now();

    const ph = phaseRef.current;
    if (ph === "ready") {
      tapsRef.current = [];
      startedAtRef.current = now;
      phaseRef.current = "squeezing";
      setPhase("squeezing");
    } else if (ph !== "squeezing") {
      reset();
      return;
    }

    const idx = tapsRef.current.length;
    if (idx >= TARGET_TAPS) return;

    tapsRef.current.push({ t: now });

    squeezeRef.current = {
      startedAt: now,
      life: SQUEEZE_LIFE,
      depth: SQUEEZE_AMOUNT * (1 + idx * 0.06),
    };
    shakeAmpRef.current = SHAKE_PER_TAP;

    const isLast = idx + 1 === TARGET_TAPS;
    if (isLast) {
      playCookingSE(SE_NIGIRI, { volume: 1.0, rate: 0.92 });
      vibrate([26, 12, 36]);
      finalize();
    } else {
      playCookingSE(SE_NIGIRI, { volume: 0.85, rate: 1.0 });
      vibrate([20]);
    }
  }, [reset, finalize]);

  // RAF
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const prev = lastFrameRef.current || now;
      const dt = Math.min((now - prev) / 1000, 0.033);
      lastFrameRef.current = now;

      // タイムアウト
      let remainingMs = TIME_BUDGET_MS;
      if (phaseRef.current === "squeezing") {
        const elapsed = now - startedAtRef.current;
        remainingMs = Math.max(0, TIME_BUDGET_MS - elapsed);
        if (remainingMs <= 0 && tapsRef.current.length < TARGET_TAPS) {
          phaseRef.current = "missed";
          setPhase("missed");
          vibrate([10, 40, 10]);
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
      const shakeY = amp > 0 ? (Math.random() - 0.5) * amp * 0.4 : 0;

      // スクイーズ進捗 → pressY と handProgress
      let pressY = 0;
      let handProgress = 0;
      const sq = squeezeRef.current;
      if (sq) {
        const age = now - sq.startedAt;
        const k = age / sq.life;
        if (k >= 1) {
          squeezeRef.current = null;
        } else {
          // フェーズ: 0..0.45 で押し込み (depth まで)
          //          0.45..0.75 で反発 (-bounce まで)
          //          0.75..1.0 で 0 に戻る
          if (k < 0.45) {
            const t = k / 0.45;
            const ease = 1 - Math.pow(1 - t, 2);
            pressY = sq.depth * ease;
            handProgress = ease;
          } else if (k < 0.75) {
            const t = (k - 0.45) / 0.3;
            pressY = sq.depth * (1 - t) - SQUEEZE_BOUNCE * t;
            handProgress = 1 - t * 0.5;
          } else {
            const t = (k - 0.75) / 0.25;
            pressY = -SQUEEZE_BOUNCE * (1 - t);
            handProgress = 0.5 * (1 - t);
          }
        }
      }

      const squeezesDone = Math.min(TARGET_TAPS, tapsRef.current.length);

      setView({
        now,
        shakeX,
        shakeY,
        scale: scaleStateRef.current,
        pressY,
        handProgress,
        squeezesDone,
        remainingMs,
      });

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      onSqueezeTap();
    },
    [onSqueezeTap],
  );

  const showImg = !imgErr[species];
  const fillPct =
    phase === "squeezing"
      ? Math.min(1, (TIME_BUDGET_MS - view.remainingMs) / TIME_BUDGET_MS)
      : 0;

  // ネタの clip-path: 柵画像の中で 1/7 切り出し
  const netaFracLeft = NETA_FRAC_LEFT[species];
  const netaFracRight = netaFracLeft + NETA_FRAC_W;
  const netaClip = `inset(0 ${((1 - netaFracRight) * 100).toFixed(2)}% 0 ${(netaFracLeft * 100).toFixed(2)}%)`;

  // 圧縮: pressY が正なら scaleY (1-pressY)、負なら (1+|pressY|)
  // ただしシャリの方が縮みやすく、ネタは少し抑え目
  const riceScaleY = 1 - view.pressY * 0.9;
  const netaScaleY = 1 - view.pressY * 0.55;
  // 同時に横に少し膨らむ (体積保存風味)
  const riceScaleX = 1 + view.pressY * 0.18;
  const netaScaleX = 1 + view.pressY * 0.1;

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
          Step3: リズム握り (Prototype)
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
              if (phase !== "squeezing") reset();
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
            "linear-gradient(180deg, #221c2a 0%, #2f2538 55%, #3c2a1f 100%)",
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
                  "radial-gradient(ellipse at 50% 28%, rgba(255,236,200,0.22), transparent 65%)",
                pointerEvents: "none",
              }}
            />

            {/* カウンター天板 */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: STAGE_H * 0.62,
                width: STAGE_W,
                height: STAGE_H * 0.38,
                background:
                  "linear-gradient(180deg, #3a2a1c 0%, #271a10 60%, #170d05 100%)",
                boxShadow: "0 -2px 0 rgba(255,255,255,0.06) inset",
              }}
            />

            {/* シャリ (CSS oval) */}
            <div
              style={{
                position: "absolute",
                left: NIGIRI_CX - RICE_W / 2,
                top: NIGIRI_CY,
                width: RICE_W,
                height: RICE_H,
                transform: `scale(${riceScaleX}, ${riceScaleY})`,
                transformOrigin: "50% 100%",
                willChange: "transform",
              }}
            >
              <RiceShape />
            </div>

            {/* ネタ (魚画像の clip-path 切り出し) */}
            <div
              style={{
                position: "absolute",
                left: NIGIRI_CX - NETA_W / 2,
                top: NIGIRI_CY - NETA_H * 0.55,
                width: NETA_W,
                height: NETA_H,
                transform: `scale(${netaScaleX}, ${netaScaleY})`,
                transformOrigin: "50% 100%",
                willChange: "transform",
                filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.55))",
              }}
            >
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  height: "100%",
                  overflow: "hidden",
                  borderRadius: 6,
                }}
              >
                {/* fish 画像をネタサイズに引き伸ばし、横方向は clip-path で 1切れ分 */}
                <NetaVisual
                  species={species}
                  imgOk={showImg}
                  clip={netaClip}
                  onImgError={() =>
                    setImgErr((prev) => ({ ...prev, [species]: true }))
                  }
                />
              </div>
            </div>

            {/* 影 */}
            <div
              style={{
                position: "absolute",
                left: NIGIRI_CX - RICE_W / 2 - 8,
                top: NIGIRI_CY + RICE_H + 4,
                width: RICE_W + 16,
                height: 14,
                background:
                  "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.45), rgba(0,0,0,0) 70%)",
                pointerEvents: "none",
              }}
            />

            {/* 手のシルエット (squeezing 中) */}
            {view.handProgress > 0 && (
              <HandSilhouette
                cx={NIGIRI_CX}
                cy={NIGIRI_CY}
                progress={view.handProgress}
              />
            )}

            {/* タイミングバー */}
            {phase === "squeezing" && (
              <div
                style={{
                  position: "absolute",
                  left: 24,
                  top: STAGE_H * 0.62 - 18,
                  width: STAGE_W - 48,
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

            {/* 進捗ピップス (3つ) */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: STAGE_H * 0.62 - 44,
                width: STAGE_W,
                display: "flex",
                justifyContent: "center",
                gap: 14,
                pointerEvents: "none",
              }}
            >
              {Array.from({ length: TARGET_TAPS }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background:
                      i < view.squeezesDone
                        ? "rgba(245,200,80,1)"
                        : "rgba(255,255,255,0.18)",
                    boxShadow:
                      i < view.squeezesDone
                        ? "0 0 8px rgba(245,200,80,0.95)"
                        : "none",
                    transition: "background 90ms",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {phase === "ready" && (
          <Hint text="3拍タップで握る (ギュッ・ギュッ・ギュッ)" />
        )}
        {phase === "missed" && (
          <Hint text="（リズム外し）タップでやり直し" tone="warn" />
        )}
        {phase === "done" && score && <ScoreOverlay score={score} />}
      </div>

      <div className="text-[10px] text-slate-500 space-y-0.5 max-w-md w-full px-2">
        <div>
          ネタ画像: {imgErr[species] ? "❌ 未配置" : "✅"} (/assets/cooking/fish/
          {species}.png から 1/7 切り出し)
        </div>
        <div>
          SE: {audioStatus.ok}/{audioStatus.total} 読み込み済 (nigiri / landing /
          clap.mp3)
        </div>
        <div className="text-slate-400">
          目安: 3タップ計 ~1.2 秒 (1拍 ~{IDEAL_INTERVAL_MS}ms)。{TIME_BUDGET_MS}ms以内
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── サブ ─────────────────────────

function RiceShape() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: "50% / 60%",
        background:
          "radial-gradient(ellipse at 50% 35%, #ffffff 0%, #fbf9f0 45%, #e8e2cf 80%, #c8c0a8 100%)",
        boxShadow:
          "0 4px 8px rgba(0,0,0,0.3), 0 -2px 4px rgba(255,255,255,0.4) inset, 0 4px 6px rgba(0,0,0,0.15) inset",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* 米粒のテクスチャ感 (細かい斑点) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 20% 30%, rgba(255,255,255,0.7) 0 1px, transparent 1.5px), radial-gradient(circle at 65% 45%, rgba(255,255,255,0.6) 0 1px, transparent 1.5px), radial-gradient(circle at 40% 65%, rgba(255,255,255,0.6) 0 1px, transparent 1.5px), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.5) 0 1px, transparent 1.5px), radial-gradient(circle at 30% 80%, rgba(255,255,255,0.5) 0 1px, transparent 1.5px)",
          mixBlendMode: "overlay",
          opacity: 0.9,
        }}
      />
    </div>
  );
}

function NetaVisual({
  species,
  imgOk,
  clip,
  onImgError,
}: {
  species: Species;
  imgOk: boolean;
  clip: string;
  onImgError: () => void;
}) {
  if (!imgOk) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background:
            "repeating-linear-gradient(45deg, rgba(255,80,80,0.2) 0 8px, rgba(255,80,80,0.06) 8px 16px)",
          border: "2px dashed rgba(255,80,80,0.7)",
          borderRadius: 6,
          color: "#ffd6d6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          fontSize: 9,
          textAlign: "center",
          padding: 2,
          lineHeight: 1.15,
        }}
      >
        <div style={{ fontWeight: 700 }}>📷 ネタ画像未配置</div>
        <div style={{ opacity: 0.85 }}>{species}.png</div>
      </div>
    );
  }
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        clipPath: clip,
        WebkitClipPath: clip,
        // clip-path で切り出すため、画像はネタ枠より広く配置 (1/7 切り出しを枠いっぱいに見せるためには 7倍幅が必要)
        // → 簡易: 元画像をネタ枠に "object-fit: cover" し、clip-path で枠内の指定区間を見せる
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={FISH_IMG(species)}
        alt={SPECIES_LABEL[species]}
        onError={onImgError}
        draggable={false}
        style={{
          // 7倍幅にして 1/7 切り出しが枠いっぱいに見えるよう左寄せ
          // ただし left オフセットは clip-path 使用時には不要。代わりに画像を枠より widePic に拡大し、
          // その上で clip 範囲内のみ表示する。視覚的にネタ表面の "中央付近" 1切れ分が見える。
          width: `${100 / NETA_FRAC_W}%`,
          height: "100%",
          objectFit: "cover",
          transform: `translateX(-${NETA_FRAC_LEFT[species] * 100 * (1 / NETA_FRAC_W)}%)`,
          userSelect: "none",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function HandSilhouette({
  cx,
  cy,
  progress,
}: {
  cx: number;
  cy: number;
  progress: number;
}) {
  // progress 0=画面外上、1=ネタに着地。手は楕円形のシルエットで簡略化
  const handTopMin = -110; // 画面外上
  const handTopMax = -10; // ネタに重なる位置
  const handTop = handTopMin + (handTopMax - handTopMin) * progress;
  const handW = 120;
  const handH = 90;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - handW / 2,
        top: cy + handTop,
        width: handW,
        height: handH,
        pointerEvents: "none",
        opacity: 0.55 + 0.35 * progress,
        filter: "drop-shadow(0 6px 8px rgba(0,0,0,0.5))",
      }}
    >
      <svg width={handW} height={handH} viewBox={`0 0 ${handW} ${handH}`}>
        {/* 手のひら + 指4本 (上から見下ろした輪郭風) */}
        <defs>
          <linearGradient id="hand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e7c8a3" />
            <stop offset="60%" stopColor="#c6a07b" />
            <stop offset="100%" stopColor="#8a6446" />
          </linearGradient>
        </defs>
        <ellipse
          cx={handW / 2}
          cy={handH * 0.65}
          rx={handW * 0.42}
          ry={handH * 0.32}
          fill="url(#hand)"
        />
        {/* 指 (簡略化) */}
        {[0.25, 0.4, 0.55, 0.7].map((fx, i) => (
          <ellipse
            key={i}
            cx={handW * fx}
            cy={handH * 0.4}
            rx={handW * 0.06}
            ry={handH * 0.22}
            fill="url(#hand)"
          />
        ))}
        {/* 親指 */}
        <ellipse
          cx={handW * 0.85}
          cy={handH * 0.55}
          rx={handW * 0.07}
          ry={handH * 0.18}
          fill="url(#hand)"
          transform={`rotate(20 ${handW * 0.85} ${handH * 0.55})`}
        />
      </svg>
    </div>
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
  const comment =
    score.stars === 3
      ? "粋な握り！"
      : score.stars === 2
        ? "上々の手つき"
        : "もう一度ゆっくり";
  return (
    <div className="absolute left-1/2 bottom-6 -translate-x-1/2 bg-slate-900/90 text-white px-5 py-3 rounded-2xl shadow-xl pointer-events-none text-center">
      <div className="text-2xl font-bold tracking-widest text-amber-300">
        {stars}
      </div>
      <div className="text-[11px] text-slate-200 mt-0.5">{comment}</div>
      <div className="text-[10px] text-slate-400 mt-1">
        {(score.totalMs / 1000).toFixed(2)}s · 揺らぎ {Math.round(score.stdMs)}ms
      </div>
      <div className="text-[10px] text-slate-400 mt-1">タップでもう一度</div>
    </div>
  );
}
