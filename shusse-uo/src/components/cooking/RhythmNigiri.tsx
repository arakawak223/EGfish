"use client";

// Step 3 リズム握り (実写動画版)
// SVG手描き演出は廃止し、寿司職人の実写動画を背景にループ再生。
// プレイヤーは「タップで握る」を 2回 (= 二貫) 行い、間隔 + 総時間で ★評価される。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const TIME_BUDGET_MS = 1800;

type Phase = "idle" | "playing" | "done";

type Result = {
  stars: 1 | 2 | 3;
  totalMs: number;
  intervalMs: number;
  comment: string;
};

function evaluate(taps: number[]): Result {
  const totalMs = taps[taps.length - 1] - taps[0];
  const intervalMs = totalMs / (TARGET_TAPS - 1);
  let stars: 1 | 2 | 3 = 1;
  let comment = "もう一息";
  if (intervalMs > 280 && intervalMs < 720 && totalMs < TIME_BUDGET_MS) {
    stars = 3;
    comment = "見事な江戸前!";
  } else if (intervalMs > 180 && intervalMs < 950 && totalMs < TIME_BUDGET_MS + 500) {
    stars = 2;
    comment = "良いリズム";
  }
  return { stars, totalMs, intervalMs, comment };
}

export default function RhythmNigiri() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [tapCount, setTapCount] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const tapTimesRef = useRef<number[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioReadyRef = useRef(false);

  const ensureAudio = useCallback(async () => {
    if (audioReadyRef.current) return;
    audioReadyRef.current = true;
    unlockCookingAudio();
    await preloadCookingAudio(ALL_SE);
  }, []);

  useEffect(() => {
    void preloadCookingAudio(ALL_SE).catch(() => {});
  }, []);

  // 動画は常に静かにループ再生 (idle 中も背景として流す)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    const tryPlay = () => {
      v.play().catch(() => {});
    };
    tryPlay();
    return () => {
      v.pause();
    };
  }, []);

  const handleStart = useCallback(async () => {
    await ensureAudio();
    tapTimesRef.current = [];
    setTapCount(0);
    setResult(null);
    setPhase("playing");
  }, [ensureAudio]);

  const handleTap = useCallback(async () => {
    if (phase !== "playing") return;
    await ensureAudio();
    const now = performance.now();
    tapTimesRef.current.push(now);
    const next = tapTimesRef.current.length;
    setTapCount(next);
    void playCookingSE(SE_NIGIRI, { volume: 0.9 });
    vibrate([20]);
    if (next >= TARGET_TAPS) {
      const r = evaluate(tapTimesRef.current);
      setResult(r);
      setPhase("done");
      void playCookingSE(SE_CLAP, { volume: 0.7 });
      vibrate([0, 30, 40, 50]);
    }
  }, [ensureAudio, phase]);

  const handleRetry = useCallback(() => {
    tapTimesRef.current = [];
    setTapCount(0);
    setResult(null);
    setPhase("idle");
  }, []);

  const stageActive = phase === "playing";
  const dots = useMemo(() => Array.from({ length: TARGET_TAPS }), []);

  return (
    <div className="relative w-full max-w-[420px] aspect-[9/16] overflow-hidden rounded-2xl bg-black shadow-xl">
      <video
        ref={videoRef}
        src={VIDEO_SRC}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-black/10 to-black/65" />

      <div className="relative z-10 flex h-full flex-col p-4 text-white">
        <header className="flex items-center justify-between text-sm">
          <Link
            href="/"
            className="rounded-full bg-black/40 px-3 py-1 backdrop-blur hover:bg-black/60"
          >
            ← 戻る
          </Link>
          <span className="rounded-full bg-black/40 px-3 py-1 backdrop-blur">
            握り (1拍 × 2貫)
          </span>
        </header>

        <div className="mt-3 flex justify-center gap-3">
          {dots.map((_, i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full border border-white/70 transition ${
                i < tapCount ? "bg-amber-300" : "bg-white/15"
              }`}
            />
          ))}
        </div>

        <div className="flex-1" />

        {phase === "idle" && (
          <div className="mb-4 flex flex-col items-center gap-3 text-center">
            <p className="text-base font-semibold drop-shadow">
              親方の手元に合わせて
              <br />
              タップで二貫握ろう
            </p>
            <button
              onClick={handleStart}
              className="rounded-full bg-amber-400 px-8 py-3 text-base font-bold text-stone-900 shadow-lg active:scale-95"
            >
              にぎり開始
            </button>
          </div>
        )}

        {phase === "done" && result && (
          <div className="mb-4 flex flex-col items-center gap-2 rounded-2xl bg-black/55 px-4 py-4 text-center backdrop-blur">
            <div className="text-3xl tracking-widest">
              {"★".repeat(result.stars)}
              <span className="text-white/30">{"★".repeat(3 - result.stars)}</span>
            </div>
            <div className="text-sm font-semibold">{result.comment}</div>
            <div className="text-xs text-white/70">
              間隔 {Math.round(result.intervalMs)} ms / 合計{" "}
              {Math.round(result.totalMs)} ms
            </div>
            <button
              onClick={handleRetry}
              className="mt-1 rounded-full bg-white/90 px-6 py-2 text-sm font-bold text-stone-900 active:scale-95"
            >
              もう一度
            </button>
          </div>
        )}
      </div>

      {/* プレイ中はステージ全体がタップ判定 */}
      {stageActive && (
        <button
          onClick={handleTap}
          aria-label="タップで握る"
          className="absolute inset-0 z-20 flex items-end justify-center pb-10 active:bg-white/5"
        >
          <span className="rounded-full bg-amber-400/95 px-8 py-3 text-base font-bold text-stone-900 shadow-lg">
            タップで握る ({tapCount}/{TARGET_TAPS})
          </span>
        </button>
      )}
    </div>
  );
}
