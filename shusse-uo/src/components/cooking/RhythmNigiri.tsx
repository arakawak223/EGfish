"use client";

// Step 3 リズム握り (案A v6: 上下分割「親方 × あなた」+ 3拍タップ型)
// - 上半分: 親方の動画 (sushi-making.mp4) ループ
// - 下半分: 単一の握りを 3拍で完成。タップタイミングで評価
// - 3拍 = ① ネタ載せ ② 押さえ1 ③ 押さえ2 (完成)
// - 評価: 各拍のジャストタイミングからのズレ → Perfect/Good/Miss → ★1〜3

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  playCookingSE,
  preloadCookingAudio,
  unlockCookingAudio,
} from "@/lib/cooking-audio";
import { vibrate } from "@/lib/haptics";

const VIDEO_SRC = "/video/sushi-making.mp4";

const IMG_SHARI = "/images/cooking/shari-top.png";
const IMG_NIGIRI_DONE = "/images/cooking/nigiri-done.png";
const IMG_NETA = "/images/cooking/fish/buri.png";

const SE_NIGIRI = "/audio/cooking/nigiri.mp3";
const SE_CLAP = "/audio/cooking/clap.mp3";
const SE_TICK = "/audio/cooking/tick.mp3";
const ALL_SE = [SE_NIGIRI, SE_CLAP, SE_TICK];

const BEATS = 3;
const BEAT_INTERVAL_MS = 650; // 92 BPM 相当
const PREP_MS = 1300; // 「3,2,1」カウントダウン
const PERFECT_WINDOW_MS = 110;
const GOOD_WINDOW_MS = 230;
const MISS_WINDOW_MS = 450; // これより遅いタップは無視

type Phase = "idle" | "prep" | "playing" | "done";
type HitGrade = "perfect" | "good" | "miss";

type Hit = { beat: number; grade: HitGrade; deltaMs: number };

type Result = {
  stars: 1 | 2 | 3;
  hits: Hit[];
  comment: string;
};

function gradeBeat(deltaAbsMs: number): HitGrade {
  if (deltaAbsMs <= PERFECT_WINDOW_MS) return "perfect";
  if (deltaAbsMs <= GOOD_WINDOW_MS) return "good";
  return "miss";
}

function evaluate(hits: Hit[]): Result {
  const score =
    hits.reduce((acc, h) => {
      if (h.grade === "perfect") return acc + 1;
      if (h.grade === "good") return acc + 0.55;
      return acc;
    }, 0) / BEATS;

  let stars: 1 | 2 | 3;
  let comment: string;
  if (score >= 0.85) {
    stars = 3;
    comment = "うむ、合格。江戸前の手だ。";
  } else if (score >= 0.5) {
    stars = 2;
    comment = "悪くない。リズムを掴め。";
  } else {
    stars = 1;
    comment = "親方の手元を見ろ。";
  }
  return { stars, hits, comment };
}

// 画像 + 失敗時 CSS フォールバック
function ImgOrFallback({
  src,
  fallback,
  className,
  style,
}: {
  src: string;
  fallback: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={className} style={style} aria-hidden>
        {fallback}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}

function FallbackShari({ pressing }: { pressing: boolean }) {
  return (
    <div
      className="h-full w-full rounded-[50%]"
      style={{
        background:
          "radial-gradient(ellipse at 35% 25%, #ffffff 0%, #fffdf3 40%, #f3ecd2 80%, #e6dcb4 100%)",
        boxShadow: pressing
          ? "inset 0 -3px 6px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.4)"
          : "inset 0 -4px 8px rgba(0,0,0,0.1), 0 4px 8px rgba(0,0,0,0.35)",
      }}
    />
  );
}

function FallbackNeta() {
  return (
    <div
      className="h-full w-full rounded-[40%]"
      style={{
        background:
          "linear-gradient(180deg, #ffb89a 0%, #f49775 40%, #d8623e 100%)",
        boxShadow:
          "inset 0 -4px 6px rgba(255,255,255,0.3), 0 2px 4px rgba(0,0,0,0.3)",
      }}
    />
  );
}

function FallbackNigiri() {
  return (
    <div className="relative h-full w-full">
      <FallbackShari pressing={false} />
      <div
        className="absolute left-1/2 top-1 h-[55%] w-[80%] -translate-x-1/2 rounded-[40%]"
        style={{
          background:
            "linear-gradient(180deg, #ffb89a 0%, #f49775 50%, #d8623e 100%)",
          boxShadow: "inset 0 -3px 5px rgba(255,255,255,0.3)",
        }}
      />
    </div>
  );
}

export default function RhythmNigiri() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [hits, setHits] = useState<Hit[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [prepCount, setPrepCount] = useState<number>(3);
  const [activeBeat, setActiveBeat] = useState<number>(-1); // 直近にハイライトすべき拍 index
  const [pressFlash, setPressFlash] = useState<boolean>(false);
  const [videoFailed, setVideoFailed] = useState(false);

  const beatTimesRef = useRef<number[]>([]); // 各拍の絶対 performance.now()
  const startMsRef = useRef<number>(0);
  const tickIntervalRef = useRef<number | null>(null);
  const prepTimerRef = useRef<number | null>(null);
  const finalizeTimerRef = useRef<number | null>(null);
  const hitsRef = useRef<Hit[]>([]);
  const beatHitRef = useRef<boolean[]>([]); // 各拍が既にタップされたか

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

  // 動画再生 (autoPlay 失敗時もコンポーネント mount 直後に play() 試行)
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

  const clearTimers = useCallback(() => {
    if (tickIntervalRef.current != null) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    if (prepTimerRef.current != null) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }
    if (finalizeTimerRef.current != null) {
      clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const finalize = useCallback(() => {
    // 未タップの拍を miss として埋める
    const filled = [...hitsRef.current];
    for (let i = 0; i < BEATS; i++) {
      if (!beatHitRef.current[i]) {
        filled.push({ beat: i, grade: "miss", deltaMs: 9999 });
      }
    }
    filled.sort((a, b) => a.beat - b.beat);
    const r = evaluate(filled);
    setHits(filled);
    setResult(r);
    setPhase("done");
    setActiveBeat(-1);
    void playCookingSE(SE_CLAP, { volume: 0.7 });
    vibrate([0, 30, 40, 50]);
  }, []);

  const startPlaying = useCallback(() => {
    const now = performance.now();
    startMsRef.current = now;
    beatTimesRef.current = Array.from(
      { length: BEATS },
      (_, i) => now + i * BEAT_INTERVAL_MS,
    );
    beatHitRef.current = Array(BEATS).fill(false);
    hitsRef.current = [];
    setHits([]);
    setActiveBeat(0);
    setPhase("playing");

    // 拍のたびに tick SE + 触覚 + activeBeat 進行
    let firedBeat = -1;
    tickIntervalRef.current = window.setInterval(() => {
      const t = performance.now();
      for (let i = 0; i < BEATS; i++) {
        if (firedBeat < i && t >= beatTimesRef.current[i] - 30) {
          firedBeat = i;
          setActiveBeat(i);
          vibrate([14]);
          void playCookingSE(SE_TICK, { volume: 0.4 });
        }
      }
      // 最終拍 + miss window を過ぎたら finalize
      const lastBeatT = beatTimesRef.current[BEATS - 1];
      if (t >= lastBeatT + MISS_WINDOW_MS) {
        if (tickIntervalRef.current != null) {
          clearInterval(tickIntervalRef.current);
          tickIntervalRef.current = null;
        }
        finalizeTimerRef.current = window.setTimeout(() => finalize(), 200);
      }
    }, 16) as unknown as number;
  }, [finalize]);

  const handleStart = useCallback(async () => {
    await ensureAudio();
    // 動画 play() を user gesture 上で再試行
    videoRef.current?.play().catch(() => {});
    clearTimers();
    hitsRef.current = [];
    beatHitRef.current = [];
    setHits([]);
    setResult(null);
    setActiveBeat(-1);
    setPrepCount(3);
    setPhase("prep");

    let count = 3;
    prepTimerRef.current = window.setInterval(() => {
      count -= 1;
      if (count > 0) {
        setPrepCount(count);
        vibrate([10]);
        void playCookingSE(SE_TICK, { volume: 0.3 });
      } else {
        if (prepTimerRef.current != null) {
          clearInterval(prepTimerRef.current);
          prepTimerRef.current = null;
        }
        startPlaying();
      }
    }, PREP_MS / 3) as unknown as number;
  }, [clearTimers, ensureAudio, startPlaying]);

  const handleRetry = useCallback(() => {
    clearTimers();
    hitsRef.current = [];
    beatHitRef.current = [];
    setHits([]);
    setResult(null);
    setActiveBeat(-1);
    setPressFlash(false);
    setPhase("idle");
  }, [clearTimers]);

  const handleTap = useCallback(() => {
    if (phase !== "playing") return;
    const now = performance.now();
    // 一番近い未タップの拍を探す
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < BEATS; i++) {
      if (beatHitRef.current[i]) continue;
      const d = now - beatTimesRef.current[i];
      if (Math.abs(d) < Math.abs(bestDelta)) {
        bestDelta = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;
    const absDelta = Math.abs(bestDelta);
    if (absDelta > MISS_WINDOW_MS) return; // 早すぎ/遅すぎは無視

    const grade = gradeBeat(absDelta);
    beatHitRef.current[bestIdx] = true;
    const hit: Hit = { beat: bestIdx, grade, deltaMs: bestDelta };
    hitsRef.current.push(hit);
    setHits([...hitsRef.current]);

    // フィードバック
    setPressFlash(true);
    setTimeout(() => setPressFlash(false), 130);
    void playCookingSE(SE_NIGIRI, { volume: 0.85 });
    if (grade === "perfect") vibrate([28]);
    else if (grade === "good") vibrate([18]);
    else vibrate([10]);
  }, [phase]);

  // 進捗で nigiri の見た目を進める
  // 0拍済: 空シャリ + ネタ上空、1拍済: ネタ着地、3拍完了 + success≥1: 完成
  const successCount = hits.filter((h) => h.grade !== "miss").length;
  const tappedCount = hits.length;
  const isPressing = pressFlash;
  const showDone = phase === "done" && successCount >= 1;
  const netaLanded = tappedCount >= 1;

  return (
    <div className="relative w-full max-w-[420px] aspect-[9/16] overflow-hidden rounded-2xl bg-stone-900 shadow-xl">
      {/* 上半分: 親方の動画 */}
      <div className="absolute inset-x-0 top-0 h-1/2 overflow-hidden bg-stone-800">
        {!videoFailed ? (
          <video
            ref={videoRef}
            src={VIDEO_SRC}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            className="h-full w-full object-cover"
            onError={() => setVideoFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-stone-700 to-stone-900 text-xs text-amber-100/60">
            動画読込失敗 ({VIDEO_SRC})
          </div>
        )}
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
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          handleTap();
        }}
        onContextMenu={(e) => e.preventDefault()}
        disabled={phase !== "playing"}
        aria-label="握る"
        className="absolute inset-x-0 bottom-0 h-1/2 select-none touch-none outline-none"
        style={{
          background:
            "linear-gradient(to bottom, #2c1f17 0%, #3a281a 30%, #4a3320 100%)",
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.25), rgba(0,0,0,0.05)), repeating-linear-gradient(90deg, #3b2818 0px, #3b2818 6px, #422c1a 6px, #422c1a 12px)",
        }}
      >
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-amber-300/95 px-3 py-1 text-xs font-bold text-stone-900 shadow">
          あなたの手元
        </div>

        {/* ビートインジケータ (3つのドット) */}
        <div className="pointer-events-none absolute inset-x-0 top-3 flex items-center justify-center gap-3">
          {Array.from({ length: BEATS }).map((_, i) => {
            const hit = hits.find((h) => h.beat === i);
            const active = activeBeat === i && phase === "playing";
            const color = hit
              ? hit.grade === "perfect"
                ? "#facc15"
                : hit.grade === "good"
                  ? "#fbbf24"
                  : "#dc2626"
              : active
                ? "#fde68a"
                : "rgba(255,255,255,0.35)";
            const size = active ? 18 : 12;
            return (
              <div
                key={i}
                className="rounded-full transition-all duration-150"
                style={{
                  width: size,
                  height: size,
                  backgroundColor: color,
                  boxShadow: active ? "0 0 12px rgba(253,230,138,0.9)" : "none",
                }}
              />
            );
          })}
        </div>

        {/* シャリ + ネタ (中央配置) */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-end justify-center">
          <div className="relative flex h-[180px] w-[200px] items-end justify-center">
            {/* シャリ or 完成握り */}
            <div
              className="relative z-10 transition-transform duration-150 ease-out"
              style={{
                transform: `scaleY(${isPressing ? 0.85 : 1}) scale(${1 + tappedCount * 0.04})`,
                width: 200,
                height: 110,
                marginBottom: 6,
                filter: isPressing ? "brightness(0.94)" : "brightness(1)",
              }}
            >
              {showDone ? (
                <ImgOrFallback
                  src={IMG_NIGIRI_DONE}
                  fallback={<FallbackNigiri />}
                  className="h-full w-full object-contain"
                  style={{
                    filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.45))",
                  }}
                />
              ) : (
                <ImgOrFallback
                  src={IMG_SHARI}
                  fallback={<FallbackShari pressing={isPressing} />}
                  className="h-full w-full object-contain"
                  style={{
                    filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.45))",
                  }}
                />
              )}
            </div>

            {/* ネタ (1拍以降は着地、done で統合) */}
            {!showDone && (
              <div
                className="absolute left-1/2 top-[20px] z-20 -translate-x-1/2 transition-all duration-200 ease-out"
                style={{
                  transform: `translate(-50%, ${netaLanded ? 0 : -50}px) scale(${netaLanded ? 1 : 0.92})`,
                  opacity: netaLanded ? 1 : 0.85,
                  width: 160,
                  height: 70,
                }}
              >
                <ImgOrFallback
                  src={IMG_NETA}
                  fallback={<FallbackNeta />}
                  className="h-full w-full object-contain"
                  style={{ filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.4))" }}
                />
              </div>
            )}
          </div>
        </div>

        {/* 操作ガイド or 結果 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-4 text-center">
          {phase === "idle" && (
            <div className="pointer-events-auto flex flex-col items-center gap-2">
              <p className="text-[13px] font-semibold text-amber-100/95 drop-shadow">
                親方のリズムに合わせて 3回タップ
                <br />
                <span className="text-[11px] text-amber-100/70">
                  ●が光ったら下の台をタップ
                </span>
              </p>
              <button
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void handleStart();
                }}
                className="rounded-full bg-amber-400 px-7 py-2 text-sm font-bold text-stone-900 shadow-lg active:scale-95"
              >
                にぎり開始
              </button>
            </div>
          )}
          {phase === "prep" && (
            <p className="rounded-full bg-black/55 px-5 py-1 text-2xl font-bold text-amber-200 backdrop-blur">
              {prepCount}
            </p>
          )}
          {phase === "playing" && (
            <p className="rounded-full bg-black/45 px-4 py-1 text-xs text-amber-100 backdrop-blur">
              {activeBeat >= 0
                ? `${activeBeat + 1}拍目!`
                : "親方を見て…"}
            </p>
          )}
          {phase === "done" && result && (
            <div className="pointer-events-auto flex w-full max-w-[320px] flex-col items-center gap-1 rounded-2xl bg-black/65 px-4 py-3 backdrop-blur">
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
              <div className="flex gap-2 text-[10px] text-white/65">
                {result.hits.map((h, i) => (
                  <span
                    key={i}
                    className={
                      h.grade === "perfect"
                        ? "text-amber-300"
                        : h.grade === "good"
                          ? "text-amber-200/80"
                          : "text-rose-400"
                    }
                  >
                    {i + 1}: {h.grade}{" "}
                    {h.grade !== "miss"
                      ? `(${h.deltaMs > 0 ? "+" : ""}${Math.round(h.deltaMs)}ms)`
                      : ""}
                  </span>
                ))}
              </div>
              <button
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleRetry();
                }}
                className="mt-1 rounded-full bg-amber-400 px-6 py-1.5 text-xs font-bold text-stone-900 active:scale-95"
              >
                もう一度
              </button>
            </div>
          )}
        </div>
      </button>
    </div>
  );
}
