"use client";

// Step 3 リズム握り (案1: 上下分割「親方 × あなた」)
// - 上半分: 親方の動画 (sushi-making.mp4) ループ
// - 下半分: 自分の手元。俵型シャリ2貫を順に長押し→リリースで握る
// - 評価: ① 各貫の押し時間 (理想 400-600ms) ② 1貫目→2貫目の間隔 ③ 総時間
// - 触覚: 押し中は連続微振動、リリースで短振動

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  playCookingSE,
  preloadCookingAudio,
  unlockCookingAudio,
} from "@/lib/cooking-audio";
import { vibrate } from "@/lib/haptics";

const VIDEO_SRC = "/video/sushi-making.mp4";

const SE_NIGIRI = "/audio/cooking/nigiri.mp3";
const SE_CLAP = "/audio/cooking/clap.mp3";
const ALL_SE = [SE_NIGIRI, SE_CLAP];

const TARGET_TAPS = 2;
const PRESS_IDEAL_MIN_MS = 400;
const PRESS_IDEAL_MAX_MS = 600;
const PRESS_OK_MIN_MS = 250;
const PRESS_OK_MAX_MS = 850;
const INTERVAL_IDEAL_MIN_MS = 280;
const INTERVAL_IDEAL_MAX_MS = 720;
const INTERVAL_OK_MIN_MS = 180;
const INTERVAL_OK_MAX_MS = 950;
const TOTAL_BUDGET_MS = 2600;

type Phase = "idle" | "playing" | "done";

type Press = { startMs: number; endMs: number };

type Result = {
  stars: 1 | 2 | 3;
  durations: number[];
  intervalMs: number;
  totalMs: number;
  comment: string;
};

function evaluate(presses: Press[]): Result {
  const durations = presses.map((p) => p.endMs - p.startMs);
  const intervalMs = presses[1].startMs - presses[0].startMs;
  const totalMs = presses[1].endMs - presses[0].startMs;

  const pressScore = (d: number): number => {
    if (d >= PRESS_IDEAL_MIN_MS && d <= PRESS_IDEAL_MAX_MS) return 1;
    if (d >= PRESS_OK_MIN_MS && d <= PRESS_OK_MAX_MS) return 0.6;
    if (d >= 120 && d <= 1300) return 0.3;
    return 0;
  };
  const intervalScore =
    intervalMs > INTERVAL_IDEAL_MIN_MS && intervalMs < INTERVAL_IDEAL_MAX_MS
      ? 1
      : intervalMs > INTERVAL_OK_MIN_MS && intervalMs < INTERVAL_OK_MAX_MS
        ? 0.6
        : 0.2;
  const totalPenalty = totalMs > TOTAL_BUDGET_MS ? 0.5 : 1;

  const score =
    ((pressScore(durations[0]) + pressScore(durations[1])) / 2) * 0.6 +
    intervalScore * 0.4;
  const finalScore = score * totalPenalty;

  let stars: 1 | 2 | 3;
  let comment: string;
  if (finalScore >= 0.85) {
    stars = 3;
    comment = "うむ、合格。江戸前の手だ。";
  } else if (finalScore >= 0.55) {
    stars = 2;
    comment = "悪くない。もう一捻り。";
  } else {
    stars = 1;
    comment = "もう一度。リズムを掴め。";
  }
  return { stars, durations, intervalMs, totalMs, comment };
}

// 俵型シャリの SVG (米粒模様つき)
function RiceBall({
  pressing,
  done,
  index,
}: {
  pressing: boolean;
  done: boolean;
  index: number;
}) {
  // pressing 中は scaleY 縮小 + 影濃く
  const sy = pressing ? 0.78 : done ? 0.92 : 1;
  const opacity = done ? 0.85 : 1;
  return (
    <div
      className="relative flex items-center justify-center transition-transform duration-150 ease-out"
      style={{ transform: `scaleY(${sy})`, opacity }}
    >
      <svg viewBox="0 0 160 80" className="h-auto w-[150px] drop-shadow-lg">
        {/* 影 */}
        <ellipse cx="80" cy="74" rx="62" ry="6" fill="rgba(0,0,0,0.35)" />
        {/* 俵本体 */}
        <ellipse cx="80" cy="44" rx="68" ry="28" fill="#fbf6e9" />
        <ellipse cx="80" cy="40" rx="64" ry="24" fill="#fffdf3" />
        {/* 米粒 */}
        {[
          [50, 32],
          [70, 28],
          [90, 30],
          [110, 34],
          [60, 42],
          [80, 40],
          [100, 44],
          [120, 40],
          [55, 52],
          [75, 54],
          [95, 52],
          [115, 50],
        ].map(([cx, cy], i) => (
          <ellipse
            key={i}
            cx={cx}
            cy={cy}
            rx="3.2"
            ry="2"
            fill="#f3ecd2"
            stroke="#e6dcb4"
            strokeWidth="0.5"
            transform={`rotate(${(i * 23) % 60 - 30} ${cx} ${cy})`}
          />
        ))}
        {/* ハイライト */}
        <ellipse cx="68" cy="32" rx="20" ry="6" fill="rgba(255,255,255,0.55)" />
      </svg>
      {/* 順番ラベル */}
      <span
        className={`absolute -top-7 flex h-7 w-7 items-center justify-center rounded-full border-2 text-sm font-bold transition ${
          done
            ? "border-amber-300 bg-amber-300 text-stone-900"
            : pressing
              ? "border-amber-200 bg-amber-200 text-stone-900"
              : "border-white/70 bg-black/40 text-white"
        }`}
      >
        {index + 1}
      </span>
    </div>
  );
}

export default function RhythmNigiri() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [completed, setCompleted] = useState<number>(0);
  const [result, setResult] = useState<Result | null>(null);

  const pressesRef = useRef<Press[]>([]);
  const startMsRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioReadyRef = useRef(false);
  const vibIntervalRef = useRef<number | null>(null);

  const ensureAudio = useCallback(async () => {
    if (audioReadyRef.current) return;
    audioReadyRef.current = true;
    unlockCookingAudio();
    await preloadCookingAudio(ALL_SE);
  }, []);

  useEffect(() => {
    void preloadCookingAudio(ALL_SE).catch(() => {});
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.play().catch(() => {});
    return () => {
      v.pause();
    };
  }, []);

  const stopVibInterval = useCallback(() => {
    if (vibIntervalRef.current != null) {
      clearInterval(vibIntervalRef.current);
      vibIntervalRef.current = null;
    }
  }, []);

  const startVibInterval = useCallback(() => {
    stopVibInterval();
    vibIntervalRef.current = window.setInterval(() => {
      vibrate([12]);
    }, 70) as unknown as number;
  }, [stopVibInterval]);

  useEffect(() => {
    return () => stopVibInterval();
  }, [stopVibInterval]);

  const handleStart = useCallback(async () => {
    await ensureAudio();
    pressesRef.current = [];
    startMsRef.current = null;
    setActiveIdx(-1);
    setCompleted(0);
    setResult(null);
    setPhase("playing");
  }, [ensureAudio]);

  const handleRetry = useCallback(() => {
    pressesRef.current = [];
    startMsRef.current = null;
    setActiveIdx(-1);
    setCompleted(0);
    setResult(null);
    setPhase("idle");
  }, []);

  const handlePressStart = useCallback(
    async (idx: number) => {
      if (phase !== "playing") return;
      if (idx !== completed) return; // 順番違いは無視
      if (activeIdx !== -1) return;
      await ensureAudio();
      startMsRef.current = performance.now();
      setActiveIdx(idx);
      vibrate([18]);
      startVibInterval();
    },
    [activeIdx, completed, ensureAudio, phase, startVibInterval],
  );

  const handlePressEnd = useCallback(
    (idx: number) => {
      if (activeIdx !== idx) return;
      const startMs = startMsRef.current;
      if (startMs == null) return;
      const endMs = performance.now();
      stopVibInterval();
      vibrate([28]);
      void playCookingSE(SE_NIGIRI, { volume: 0.9 });
      pressesRef.current.push({ startMs, endMs });
      startMsRef.current = null;
      setActiveIdx(-1);
      const next = completed + 1;
      setCompleted(next);
      if (next >= TARGET_TAPS) {
        const r = evaluate(pressesRef.current);
        setResult(r);
        setPhase("done");
        void playCookingSE(SE_CLAP, { volume: 0.7 });
        vibrate([0, 30, 40, 50]);
      }
    },
    [activeIdx, completed, stopVibInterval],
  );

  return (
    <div className="relative w-full max-w-[420px] aspect-[9/16] overflow-hidden rounded-2xl bg-stone-900 shadow-xl">
      {/* 上半分: 親方の動画 */}
      <div className="absolute inset-x-0 top-0 h-1/2 overflow-hidden">
        <video
          ref={videoRef}
          src={VIDEO_SRC}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          className="h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/55" />
        <div className="absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1 text-xs font-bold text-amber-200 backdrop-blur">
          親方の手元
        </div>
        <Link
          href="/"
          className="absolute right-3 top-3 rounded-full bg-black/55 px-3 py-1 text-xs text-white backdrop-blur"
        >
          ← 戻る
        </Link>
      </div>

      {/* 下半分: あなたの手元 */}
      <div
        className="absolute inset-x-0 bottom-0 h-1/2 select-none"
        style={{
          background:
            "linear-gradient(to bottom, #2c1f17 0%, #3a281a 30%, #4a3320 100%)",
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.25), rgba(0,0,0,0.05)), repeating-linear-gradient(90deg, #3b2818 0px, #3b2818 6px, #422c1a 6px, #422c1a 12px)",
        }}
      >
        <div className="absolute left-3 top-3 rounded-full bg-amber-300/95 px-3 py-1 text-xs font-bold text-stone-900 shadow">
          あなたの手元
        </div>

        {/* シャリ2貫 */}
        <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-around px-4">
          {[0, 1].map((idx) => {
            const pressing = activeIdx === idx;
            const done = completed > idx;
            const next = phase === "playing" && completed === idx;
            return (
              <button
                key={idx}
                type="button"
                disabled={phase !== "playing" || (!next && !pressing)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  void handlePressStart(idx);
                }}
                onPointerUp={(e) => {
                  e.preventDefault();
                  handlePressEnd(idx);
                }}
                onPointerCancel={() => handlePressEnd(idx)}
                onPointerLeave={() => {
                  if (activeIdx === idx) handlePressEnd(idx);
                }}
                onContextMenu={(e) => e.preventDefault()}
                className={`relative touch-none rounded-xl p-2 outline-none transition ${
                  next ? "ring-2 ring-amber-300/80" : ""
                } ${pressing ? "scale-[0.98]" : ""}`}
                aria-label={`${idx + 1}貫目を握る`}
              >
                <RiceBall index={idx} pressing={pressing} done={done} />
              </button>
            );
          })}
        </div>

        {/* 操作ガイド or ボタン or 結果 */}
        <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-4 text-center">
          {phase === "idle" && (
            <>
              <p className="text-[13px] font-semibold text-amber-100/95 drop-shadow">
                親方を見て、二貫を順に押さえよう
                <br />
                <span className="text-[11px] text-amber-100/70">
                  長押し → さっと離す (1 → 2)
                </span>
              </p>
              <button
                onClick={handleStart}
                className="rounded-full bg-amber-400 px-7 py-2 text-sm font-bold text-stone-900 shadow-lg active:scale-95"
              >
                にぎり開始
              </button>
            </>
          )}
          {phase === "playing" && (
            <p className="rounded-full bg-black/45 px-4 py-1 text-xs text-amber-100 backdrop-blur">
              {activeIdx >= 0
                ? `${activeIdx + 1}貫目を押さえてる… さっと離す!`
                : `${completed + 1}貫目を長押し`}
            </p>
          )}
          {phase === "done" && result && (
            <div className="flex w-full max-w-[320px] flex-col items-center gap-1 rounded-2xl bg-black/65 px-4 py-3 backdrop-blur">
              <div className="text-2xl tracking-widest">
                <span className="text-amber-300">
                  {"★".repeat(result.stars)}
                </span>
                <span className="text-white/25">
                  {"★".repeat(3 - result.stars)}
                </span>
              </div>
              <div className="text-sm font-semibold text-amber-100">
                {result.comment}
              </div>
              <div className="text-[10px] text-white/65">
                握り {Math.round(result.durations[0])} / {Math.round(result.durations[1])} ms
                ・ 間隔 {Math.round(result.intervalMs)} ms
              </div>
              <button
                onClick={handleRetry}
                className="mt-1 rounded-full bg-amber-400 px-6 py-1.5 text-xs font-bold text-stone-900 active:scale-95"
              >
                もう一度
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
