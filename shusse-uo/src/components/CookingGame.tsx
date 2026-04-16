"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CaughtFish, calculateFreshness } from "@/lib/game-state";
import { FISH_DATABASE, FishSpecies } from "@/lib/fish-data";
import { vibrate, HAPTIC_PATTERNS } from "@/lib/haptics";
import {
  playSESlice, playSESell, playSEMiss, playSEPrepDone,
  playSEKnifeEntry, playSESmoothSlide, playSEBoneResist,
  playSERiceGrab, playSENetaCombine, playSENigiriPerfect, playSENigiriFail,
} from "@/lib/audio";

interface CookingGameProps {
  inventory: CaughtFish[];
  marketTrend: Partial<Record<FishSpecies, number>>;
  onSell: (fishId: string, price: number) => void;
  timeMultiplier?: number;
  paused?: boolean;
}

// 6段階の調理ステート
type PrepState =
  | "idle"
  | "cut-entry"    // 包丁を入れる（長押し）
  | "cut-slide"    // 中骨に沿って滑らせる（速度制御スワイプ）
  | "cut-belly"    // 腹骨をすく（弧スワイプ）
  | "nigiri-rice"  // シャリを取る（長押しでサイズ決定）
  | "nigiri-pinch" // ネタと合わせる（二本指ピンチ）
  | "nigiri-press" // 本手返し（圧力ゲージ）
  | "done";

interface PrepProgress {
  fishId: string;
  state: PrepState;
  entryScore: number;
  slideScore: number;
  bellyScore: number;
  cutAccuracy: number;
  riceScore: number;
  pinchScore: number;
  pressScore: number;
  nigiriScore: number;
  avgAccuracy: number;
  perfect: boolean;
}

// 限定メニュー: カウンターに出した寿司
interface CounterItem {
  fishId: string;
  price: number;
  placedAt: number;
  waitTime: number;
  customerArrived: boolean;
  expired: boolean;
}

const MAX_COUNTER_SLOTS = 2;
const COUNTER_BASE_WAIT = 8;
const COUNTER_MAX_WAIT = 20;

const AREA_W = 280;
const AREA_H = 160;

// ── 三枚おろしパラメータ ──
const ENTRY_HOLD_MS = 600;         // 包丁を入れるのに必要な長押し時間
const ENTRY_CIRCLE_X = 50;        // 頭の位置 X
const ENTRY_CIRCLE_Y = AREA_H / 2;
const ENTRY_CIRCLE_R = 28;

// 中骨ライン: 左端→右端、少し曲線
const BONE_START_X = 40;
const BONE_END_X = AREA_W - 30;
const BONE_Y = AREA_H / 2 - 5;
// 速度判定 (px/sec)
const SLIDE_IDEAL_MIN = 60;
const SLIDE_IDEAL_MAX = 180;
const SLIDE_TOO_FAST = 260;

// 腹骨の弧
const BELLY_ARC_POINTS = 20; // 弧を構成する点の数

// ── 握りパラメータ ──
const RICE_MAX_HOLD_MS = 1800;    // シャリの最大長押し時間
const PINCH_INITIAL_DIST = 100;   // ピンチ開始時の理想指間距離(px)
const PINCH_COMPLETE_DIST = 25;   // ピンチ完了判定距離(px)
const PRESS_MAX_MS = 2200;        // 圧力ゲージが満タンになる時間

// 魚サイズごとの理想値
function getIdealRiceRatio(size: "small" | "medium" | "large"): number {
  // 0-1 の範囲での理想リリースタイミング
  switch (size) {
    case "small": return 0.28;
    case "medium": return 0.50;
    case "large": return 0.68;
  }
}

function getIdealPressRange(size: "small" | "medium" | "large"): [number, number] {
  // 圧力ゲージ(0-1)の理想範囲
  switch (size) {
    case "small": return [0.20, 0.42];   // 繊細
    case "medium": return [0.35, 0.60];
    case "large": return [0.48, 0.72];   // しっかり
  }
}

// 腹骨の弧パスを生成
function generateBellyArc(difficulty: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  // 弧の開始・終了位置（難度で変動）
  const startX = AREA_W * 0.65;
  const startY = AREA_H * 0.32;
  const endX = AREA_W * 0.25;
  const endY = AREA_H * 0.78;
  // ベジェ制御点
  const cpX = AREA_W * (0.25 + difficulty * 0.15);
  const cpY = AREA_H * 0.25;

  for (let i = 0; i <= BELLY_ARC_POINTS; i++) {
    const t = i / BELLY_ARC_POINTS;
    const u = 1 - t;
    const x = u * u * startX + 2 * u * t * cpX + t * t * endX;
    const y = u * u * startY + 2 * u * t * cpY + t * t * endY;
    points.push({ x, y });
  }
  return points;
}

// 弧への平均距離でスコア算出
function scoreArcFollowing(
  drawn: { x: number; y: number }[],
  arc: { x: number; y: number }[],
): number {
  if (drawn.length < 3) return 0;
  let totalDist = 0;
  for (const p of drawn) {
    let minDist = Infinity;
    for (const a of arc) {
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d < minDist) minDist = d;
    }
    totalDist += minDist;
  }
  const avgDist = totalDist / drawn.length;
  // avgDist 0 = perfect, 30+ = 0 score
  return Math.max(0, Math.min(1, 1 - avgDist / 30));
}

// ピンチスコア: 指間距離の減少のスムーズさ
function scorePinch(samples: number[]): number {
  if (samples.length < 3) return 0;
  const start = samples[0];
  const end = samples[samples.length - 1];
  // 十分に閉じたか
  const closedRatio = Math.max(0, Math.min(1, (start - end) / (start * 0.6)));
  // 滑らかさ: 距離が単調減少に近いか
  let monotone = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] <= samples[i - 1] + 5) monotone++;
  }
  const smoothness = monotone / (samples.length - 1);
  return closedRatio * 0.6 + smoothness * 0.4;
}

export default function CookingGame({
  inventory, marketTrend, onSell, timeMultiplier = 1, paused = false,
}: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [counter, setCounter] = useState<CounterItem[]>([]);
  const [flash, setFlash] = useState<{ fishId: string; kind: string; at: number } | null>(null);
  // リアルタイム描画用
  const [, setTick] = useState(0);
  const forceTick = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);

  // アクティブ状態（ref管理 → パフォーマンスのためstateにしない）
  const activePhaseRef = useRef<{
    fishId: string;
    phase: PrepState;
    startTime: number;
    // cut-entry
    holdProgress?: number;
    holdInCircle?: boolean;
    // cut-slide
    slidePoints?: { x: number; y: number; t: number }[];
    slideVelocities?: number[];
    slideLastVibTime?: number;
    slideSpeedZone?: "slow" | "ideal" | "fast";
    // cut-belly
    bellyArc?: { x: number; y: number }[];
    bellyPoints?: { x: number; y: number }[];
    // nigiri-rice
    riceRatio?: number;
    // nigiri-pinch
    pinchSamples?: number[];
    pinchStartDist?: number;
    pinchComplete?: boolean;
    // nigiri-press
    pressRatio?: number;
  } | null>(null);
  const activeRectRef = useRef<DOMRect | null>(null);

  // 一時停止でアクティブフェーズをキャンセル
  useEffect(() => {
    if (!paused) return;
    if (activePhaseRef.current) {
      activePhaseRef.current = null;
      forceTick();
    }
  }, [paused, forceTick]);

  // 一時停止復帰でカウンター時間補正
  const pauseStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (paused) {
      pauseStartRef.current = Date.now();
      return;
    }
    if (pauseStartRef.current != null) {
      const delta = Date.now() - pauseStartRef.current;
      pauseStartRef.current = null;
      if (delta > 0) {
        setCounter((prev) => prev.map((item) => ({ ...item, placedAt: item.placedAt + delta })));
      }
    }
  }, [paused]);

  // 鮮度更新
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const updated: Record<string, number> = {};
      for (const fish of inventory) {
        updated[fish.id] = calculateFreshness(fish.caughtAt, now);
      }
      setFreshness(updated);
    }, 500);
    return () => clearInterval(interval);
  }, [inventory, paused]);

  // カウンター客到着 & 期限切れ
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setCounter((prev) => {
        let changed = false;
        const updated = prev.map((item) => {
          if (item.customerArrived || item.expired) return item;
          const elapsed = (now - item.placedAt) / 1000;
          if (elapsed >= item.waitTime) {
            changed = true;
            playSESell();
            vibrate(HAPTIC_PATTERNS.sell);
            onSell(item.fishId, item.price);
            return { ...item, customerArrived: true };
          }
          if (elapsed >= item.waitTime * 2) {
            changed = true;
            playSEMiss();
            onSell(item.fishId, Math.round(item.price * 0.3));
            return { ...item, expired: true };
          }
          return item;
        });
        const cleaned = updated.filter((c) => !c.customerArrived && !c.expired);
        return changed ? cleaned : (cleaned.length !== prev.length ? cleaned : prev);
      });
    }, 300);
    return () => clearInterval(interval);
  }, [onSell, paused]);

  // ── アニメーションループ（長押し系のプログレス更新）──
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const loop = () => {
      const active = activePhaseRef.current;
      if (active) {
        const now = performance.now();
        const elapsed = now - active.startTime;

        if (active.phase === "cut-entry") {
          active.holdProgress = Math.min(1, elapsed / (ENTRY_HOLD_MS * timeMultiplier));
          if (active.holdProgress >= 1) {
            // 包丁が入った！
            vibrate(HAPTIC_PATTERNS.knifeEntry);
            playSEKnifeEntry();
            const fishId = active.fishId;
            // エントリースコア: ホールド中にサークル内に留まったか
            const entryScore = active.holdInCircle ? 1.0 : 0.6;
            activePhaseRef.current = null;
            setPrepProgress((prev) => ({
              ...prev,
              [fishId]: {
                ...(prev[fishId] ?? makeInitialPrep(fishId)),
                state: "cut-slide",
                entryScore,
              },
            }));
            setFlash({ fishId, kind: "entry", at: now });
          }
          forceTick();
        }

        if (active.phase === "nigiri-rice") {
          active.riceRatio = Math.min(1, elapsed / (RICE_MAX_HOLD_MS * timeMultiplier));
          forceTick();
        }

        if (active.phase === "nigiri-press") {
          active.pressRatio = Math.min(1, elapsed / (PRESS_MAX_MS * timeMultiplier));
          // 満タンになったら自動リリース（強すぎ）
          if (active.pressRatio >= 1) {
            finishPress(active.fishId, 1.0);
          }
          forceTick();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, timeMultiplier]);

  // ── ヘルパー ──

  function makeInitialPrep(fishId: string): PrepProgress {
    return {
      fishId, state: "idle",
      entryScore: 0, slideScore: 0, bellyScore: 0, cutAccuracy: 0,
      riceScore: 0, pinchScore: 0, pressScore: 0, nigiriScore: 0,
      avgAccuracy: 0, perfect: false,
    };
  }

  const getClientPos = (e: React.MouseEvent | React.TouchEvent) => {
    if ("touches" in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if ("clientX" in e) return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
    return null;
  };

  const toRelative = (clientX: number, clientY: number) => {
    const rect = activeRectRef.current;
    if (!rect) return null;
    const scaleX = AREA_W / rect.width;
    const scaleY = AREA_H / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  // ── フェーズ開始 ──

  const startCutEntry = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    // 頭の円内でのみ反応
    const dist = Math.hypot(pos.x - ENTRY_CIRCLE_X, pos.y - ENTRY_CIRCLE_Y);
    if (dist > ENTRY_CIRCLE_R + 10) return;

    activePhaseRef.current = {
      fishId: fish.id,
      phase: "cut-entry",
      startTime: performance.now(),
      holdProgress: 0,
      holdInCircle: true,
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const handleEntryMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-entry") return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;
    const dist = Math.hypot(pos.x - ENTRY_CIRCLE_X, pos.y - ENTRY_CIRCLE_Y);
    if (dist > ENTRY_CIRCLE_R + 15) {
      active.holdInCircle = false;
    }
  }, []);

  const handleEntryEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-entry") return;
    // 途中で離した → キャンセル
    activePhaseRef.current = null;
    forceTick();
  }, [forceTick]);

  // ── 中骨スライド ──

  const startSlide = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    // 左端付近でのみ開始
    if (pos.x > BONE_START_X + 30 || Math.abs(pos.y - BONE_Y) > 30) return;

    activePhaseRef.current = {
      fishId: fish.id,
      phase: "cut-slide",
      startTime: performance.now(),
      slidePoints: [{ ...pos, t: performance.now() }],
      slideVelocities: [],
      slideLastVibTime: 0,
      slideSpeedZone: "slow",
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const handleSlideMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-slide" || !active.slidePoints) return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;
    const now = performance.now();

    const prev = active.slidePoints[active.slidePoints.length - 1];
    const dx = pos.x - prev.x;
    const dy = pos.y - prev.y;
    const dt = (now - prev.t) / 1000; // sec
    if (dt < 0.01) return; // 短すぎるサンプルは無視

    const dist = Math.hypot(dx, dy);
    const velocity = dist / dt; // px/sec

    active.slidePoints.push({ ...pos, t: now });
    active.slideVelocities!.push(velocity);

    // 速度ゾーン判定 & ハプティクス
    const adjustedMax = SLIDE_IDEAL_MAX * (1 + (1 - timeMultiplier) * 0.3);
    const adjustedFast = SLIDE_TOO_FAST * (1 + (1 - timeMultiplier) * 0.3);
    const vibInterval = 120; // ハプティクス最小間隔ms

    if (velocity > adjustedFast) {
      active.slideSpeedZone = "fast";
      if (now - (active.slideLastVibTime ?? 0) > vibInterval) {
        vibrate(HAPTIC_PATTERNS.boneResist);
        playSEBoneResist();
        active.slideLastVibTime = now;
      }
    } else if (velocity >= SLIDE_IDEAL_MIN && velocity <= adjustedMax) {
      active.slideSpeedZone = "ideal";
      if (now - (active.slideLastVibTime ?? 0) > vibInterval * 2) {
        vibrate(HAPTIC_PATTERNS.smoothSlide);
        playSESmoothSlide();
        active.slideLastVibTime = now;
      }
    } else {
      active.slideSpeedZone = "slow";
    }

    // 右端に到達 → 完了
    if (pos.x >= BONE_END_X - 15) {
      const velocities = active.slideVelocities!;
      // 適正速度帯にいた割合
      let idealCount = 0;
      let fastCount = 0;
      for (const v of velocities) {
        if (v >= SLIDE_IDEAL_MIN && v <= adjustedMax) idealCount++;
        if (v > adjustedFast) fastCount++;
      }
      const idealRatio = velocities.length > 0 ? idealCount / velocities.length : 0;
      const fastPenalty = velocities.length > 0 ? fastCount / velocities.length : 0;
      // 骨線からの距離精度
      const pts = active.slidePoints!;
      let totalDeviation = 0;
      for (const p of pts) {
        totalDeviation += Math.abs(p.y - BONE_Y);
      }
      const avgDeviation = totalDeviation / pts.length;
      const pathAcc = Math.max(0, Math.min(1, 1 - avgDeviation / 25));

      const slideScore = Math.max(0, Math.min(1,
        idealRatio * 0.5 + pathAcc * 0.35 - fastPenalty * 0.3 + 0.15
      ));

      const fishId = active.fishId;
      playSESlice();
      vibrate([20, 8, 12]);
      activePhaseRef.current = null;

      setPrepProgress((prev) => {
        const p = prev[fishId] ?? makeInitialPrep(fishId);
        return {
          ...prev,
          [fishId]: { ...p, state: "cut-belly", slideScore },
        };
      });
      if (slideScore >= 0.8) {
        setFlash({ fishId, kind: "combo", at: now });
      }
    }

    forceTick();
  }, [timeMultiplier, forceTick]);

  const handleSlideEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-slide") return;
    // 途中で離した → 低スコアで完了
    const fishId = active.fishId;
    const slideScore = 0.2;
    activePhaseRef.current = null;
    setPrepProgress((prev) => {
      const p = prev[fishId] ?? makeInitialPrep(fishId);
      return { ...prev, [fishId]: { ...p, state: "cut-belly", slideScore } };
    });
    forceTick();
  }, [forceTick]);

  // ── 腹骨すく ──

  const startBelly = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    const fishData = FISH_DATABASE[fish.species];
    const stage = fishData.stages[fish.stageIndex];
    const arc = generateBellyArc(stage.prepDifficulty);

    // 弧の開始点付近でのみ反応
    const distToStart = Math.hypot(pos.x - arc[0].x, pos.y - arc[0].y);
    if (distToStart > 35) return;

    activePhaseRef.current = {
      fishId: fish.id,
      phase: "cut-belly",
      startTime: performance.now(),
      bellyArc: arc,
      bellyPoints: [{ x: pos.x, y: pos.y }],
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const handleBellyMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-belly" || !active.bellyArc) return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    active.bellyPoints!.push({ x: pos.x, y: pos.y });

    // 弧の終点付近に到達 → 完了
    const arcEnd = active.bellyArc[active.bellyArc.length - 1];
    const distToEnd = Math.hypot(pos.x - arcEnd.x, pos.y - arcEnd.y);

    if (distToEnd < 30 && active.bellyPoints!.length >= 5) {
      const bellyScore = scoreArcFollowing(active.bellyPoints!, active.bellyArc);
      const fishId = active.fishId;
      playSESlice();
      vibrate([15, 5, 25]);
      activePhaseRef.current = null;

      setPrepProgress((prev) => {
        const p = prev[fishId] ?? makeInitialPrep(fishId);
        const cutAcc = Math.min(1,
          p.entryScore * 0.25 + p.slideScore * 0.45 + bellyScore * 0.30
        );
        const cutPerfect = cutAcc >= 0.8;
        return {
          ...prev,
          [fishId]: {
            ...p,
            state: "nigiri-rice",
            bellyScore,
            cutAccuracy: cutAcc,
            avgAccuracy: cutAcc,
            perfect: cutPerfect,
          },
        };
      });
      playSEPrepDone();
      if (bellyScore >= 0.8) {
        setFlash({ fishId, kind: "perfect", at: performance.now() });
      }
    }
    forceTick();
  }, [forceTick]);

  const handleBellyEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-belly") return;
    // 途中離し → 低スコア
    const fishId = active.fishId;
    const bellyScore = active.bellyPoints && active.bellyArc
      ? scoreArcFollowing(active.bellyPoints, active.bellyArc) * 0.5
      : 0.1;
    activePhaseRef.current = null;

    setPrepProgress((prev) => {
      const p = prev[fishId] ?? makeInitialPrep(fishId);
      const cutAcc = Math.min(1, p.entryScore * 0.25 + p.slideScore * 0.45 + bellyScore * 0.30);
      return {
        ...prev,
        [fishId]: {
          ...p,
          state: "nigiri-rice",
          bellyScore,
          cutAccuracy: cutAcc,
          avgAccuracy: cutAcc,
          perfect: cutAcc >= 0.8,
        },
      };
    });
    playSEPrepDone();
    forceTick();
  }, [forceTick]);

  // ── シャリを取る（長押し） ──

  const startRice = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    e.preventDefault();
    activePhaseRef.current = {
      fishId: fish.id,
      phase: "nigiri-rice",
      startTime: performance.now(),
      riceRatio: 0,
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const handleRiceEnd = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "nigiri-rice") return;

    const ratio = active.riceRatio ?? 0;
    const fishData = FISH_DATABASE[fish.species];
    const stage = fishData.stages[fish.stageIndex];
    const idealRatio = getIdealRiceRatio(stage.size);

    // 理想値との差でスコア
    const diff = Math.abs(ratio - idealRatio);
    const riceScore = Math.max(0, Math.min(1, 1 - diff / 0.3));

    playSERiceGrab();
    vibrate(HAPTIC_PATTERNS.riceGrab);
    activePhaseRef.current = null;

    setPrepProgress((prev) => {
      const p = prev[fish.id] ?? makeInitialPrep(fish.id);
      return { ...prev, [fish.id]: { ...p, state: "nigiri-pinch", riceScore } };
    });
    if (riceScore >= 0.85) {
      setFlash({ fishId: fish.id, kind: "combo", at: performance.now() });
    }
    forceTick();
  }, [forceTick]);

  // ── ネタと合わせる（ピンチ） ──

  const handlePinchStart = useCallback((fish: CaughtFish, e: React.TouchEvent) => {
    if (activePhaseRef.current?.phase === "nigiri-pinch" && activePhaseRef.current.fishId === fish.id) return;
    if (e.touches.length >= 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      activePhaseRef.current = {
        fishId: fish.id,
        phase: "nigiri-pinch",
        startTime: performance.now(),
        pinchSamples: [d],
        pinchStartDist: d,
        pinchComplete: false,
      };
      vibrate([6]);
      forceTick();
    }
  }, [forceTick]);

  const handlePinchMove = useCallback((e: React.TouchEvent) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "nigiri-pinch" || active.pinchComplete) return;
    if (e.touches.length < 2) return;
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
    active.pinchSamples!.push(d);

    if (d < PINCH_COMPLETE_DIST) {
      active.pinchComplete = true;
      const pinchScore = scorePinch(active.pinchSamples!);
      finishPinch(active.fishId, pinchScore);
    }
    forceTick();
  }, [forceTick]);

  const handlePinchEnd = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "nigiri-pinch") return;
    if (active.pinchComplete) return;
    // 途中離し → スコア判定
    const pinchScore = active.pinchSamples && active.pinchSamples.length > 2
      ? scorePinch(active.pinchSamples) * 0.7
      : 0.3;
    finishPinch(fish.id, pinchScore);
  }, []);

  // デスクトップ用ピンチ代替: ドラッグで合わせる
  const handlePinchMouseDown = useCallback((fish: CaughtFish) => {
    if (activePhaseRef.current?.phase === "nigiri-pinch") return;
    activePhaseRef.current = {
      fishId: fish.id,
      phase: "nigiri-pinch",
      startTime: performance.now(),
      pinchSamples: [PINCH_INITIAL_DIST],
      pinchStartDist: PINCH_INITIAL_DIST,
      pinchComplete: false,
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const handlePinchMouseUp = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "nigiri-pinch") return;
    // デスクトップではクリック＝合わせ完了
    const pinchScore = 0.75; // デスクトップでは固定中程度スコア
    finishPinch(fish.id, pinchScore);
  }, []);

  function finishPinch(fishId: string, pinchScore: number) {
    playSENetaCombine();
    vibrate(HAPTIC_PATTERNS.pinch);
    activePhaseRef.current = null;

    setPrepProgress((prev) => {
      const p = prev[fishId] ?? makeInitialPrep(fishId);
      return { ...prev, [fishId]: { ...p, state: "nigiri-press", pinchScore } };
    });
    if (pinchScore >= 0.85) {
      setFlash({ fishId, kind: "combo", at: performance.now() });
    }
    forceTick();
  }

  // ── 本手返し（圧力） ──

  const startPress = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    e.preventDefault();
    activePhaseRef.current = {
      fishId: fish.id,
      phase: "nigiri-press",
      startTime: performance.now(),
      pressRatio: 0,
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const finishPress = useCallback((fishId: string, ratio: number) => {
    activePhaseRef.current = null;

    setPrepProgress((prev) => {
      const p = prev[fishId] ?? makeInitialPrep(fishId);
      const fish = inventory.find((f) => f.id === fishId);
      if (!fish) return prev;
      const fishData = FISH_DATABASE[fish.species];
      const stage = fishData.stages[fish.stageIndex];
      const [lo, hi] = getIdealPressRange(stage.size);

      let pressScore: number;
      if (ratio >= lo && ratio <= hi) {
        // 理想範囲内 → 完璧
        const center = (lo + hi) / 2;
        const halfRange = (hi - lo) / 2;
        pressScore = 1 - Math.abs(ratio - center) / halfRange * 0.15;
      } else {
        // 範囲外 → 距離に応じて減点
        const distToRange = ratio < lo ? lo - ratio : ratio - hi;
        pressScore = Math.max(0, 1 - distToRange / 0.35);
      }
      pressScore = Math.max(0, Math.min(1, pressScore));

      const nigiriAcc = Math.min(1,
        p.riceScore * 0.30 + p.pinchScore * 0.25 + pressScore * 0.45
      );
      const finalAcc = Math.min(1, p.cutAccuracy * 0.55 + nigiriAcc * 0.45);
      const perfectAll = finalAcc >= 0.82;

      // フィードバック
      if (pressScore >= 0.85) {
        vibrate(HAPTIC_PATTERNS.pressPerfect);
        playSENigiriPerfect();
      } else if (ratio < lo) {
        vibrate(HAPTIC_PATTERNS.pressSoft);
        playSENigiriFail();
      } else {
        vibrate(HAPTIC_PATTERNS.pressHard);
        playSENigiriFail();
      }

      if (perfectAll) {
        setFlash({ fishId, kind: "perfect", at: performance.now() });
      }
      playSEPrepDone();

      return {
        ...prev,
        [fishId]: {
          ...p,
          state: "done",
          pressScore,
          nigiriScore: nigiriAcc,
          avgAccuracy: finalAcc,
          perfect: perfectAll,
        },
      };
    });
    forceTick();
  }, [inventory, forceTick]);

  const handlePressEnd = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "nigiri-press") return;
    finishPress(fish.id, active.pressRatio ?? 0);
  }, [finishPress]);

  // ── 販売 ──

  const handleInstantSell = (fish: CaughtFish) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;
    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const prep = prepProgress[fish.id];
    const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1;
    const price = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult);
    onSell(fish.id, price);
    playSESell();
  };

  const handlePlaceOnCounter = (fish: CaughtFish) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;
    const activeCounter = counter.filter((c) => !c.customerArrived && !c.expired);
    if (activeCounter.length >= MAX_COUNTER_SLOTS) return;

    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const prep = prepProgress[fish.id];
    const qualityMult = prep ? 0.8 + prep.avgAccuracy * 0.7 : 1;
    const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMult);

    const rarityBonus = fish.sushiPrice > 2000 ? 0.6 : fish.sushiPrice > 800 ? 0.8 : 1.0;
    const waitTime = COUNTER_BASE_WAIT + Math.random() * (COUNTER_MAX_WAIT - COUNTER_BASE_WAIT) * rarityBonus;

    setCounter((prev) => [
      ...prev,
      { fishId: fish.id, price: premiumPrice, placedAt: Date.now(), waitTime, customerArrived: false, expired: false },
    ]);
  };

  const activeCounterCount = counter.filter((c) => !c.customerArrived && !c.expired).length;
  const counterFull = activeCounterCount >= MAX_COUNTER_SLOTS;

  const accuracyLabel = (acc: number) => {
    if (acc >= 0.85) return { text: "極上", color: "text-yellow-500", icon: "✨" };
    if (acc >= 0.6) return { text: "上物", color: "text-green-500", icon: "○" };
    if (acc >= 0.35) return { text: "並", color: "text-gray-500", icon: "△" };
    return { text: "雑", color: "text-red-400", icon: "✕" };
  };

  // フェーズヒントテキスト
  const phaseHint = (state: PrepState) => {
    switch (state) {
      case "cut-entry": return "頭の付け根を長押しして包丁を入れる";
      case "cut-slide": return "中骨に沿ってゆっくり右へ滑らせる";
      case "cut-belly": return "腹骨の弧に沿って丁寧にすく";
      case "nigiri-rice": return "長押しでシャリを取る（魚に合うサイズで離す）";
      case "nigiri-pinch": return "二本指で挟んでネタとシャリを合わせる";
      case "nigiri-press": return "押さえて離す — 空気を含ませる絶妙な圧で";
      default: return "";
    }
  };

  // ── 表示 ──

  if (inventory.length === 0 && activeCounterCount === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gradient-to-b from-amber-50 to-orange-100 text-gray-600">
        <div className="text-center p-8">
          <div className="text-5xl mb-4">🍣</div>
          <p className="text-lg font-bold mb-1">在庫なし</p>
          <p className="text-sm">兄が魚を釣るのを待ちましょう！</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-gradient-to-b from-amber-50 to-orange-100 overflow-y-auto p-3">
      {/* カウンター席 */}
      {activeCounterCount > 0 && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-purple-700">
              🍽 カウンター席（{activeCounterCount}/{MAX_COUNTER_SLOTS}）
            </span>
          </div>
          <div className="space-y-2">
            {counter
              .filter((c) => !c.customerArrived && !c.expired)
              .map((item) => {
                const elapsed = (Date.now() - item.placedAt) / 1000;
                const timeLeft = Math.max(0, item.waitTime * 2 - elapsed);
                const progress = Math.min(100, (elapsed / item.waitTime) * 100);
                const arriving = elapsed >= item.waitTime * 0.7;
                const fish = inventory.find((f) => f.id === item.fishId);
                const fishData = fish ? FISH_DATABASE[fish.species] : null;
                return (
                  <div key={item.fishId} className="bg-white rounded-lg p-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-bold">
                        {fish?.stageName ?? "寿司"}
                        {fishData && <span className="text-gray-400 ml-1">({fishData.displayName})</span>}
                      </span>
                      <span className="text-purple-600 font-bold">¥{item.price.toLocaleString()}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          arriving ? "bg-purple-500 animate-pulse" : "bg-purple-300"
                        }`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="text-xs mt-0.5 text-gray-500">
                      {arriving ? (
                        <span className="text-purple-600 font-bold">お客様が近づいています...</span>
                      ) : (
                        <span>客待ち中... 残り{Math.ceil(timeLeft)}秒</span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {inventory
          .filter((fish) => !counter.some((c) => c.fishId === fish.id && !c.customerArrived && !c.expired))
          .map((fish) => {
          const fishData = FISH_DATABASE[fish.species];
          const stage = fishData.stages[fish.stageIndex];
          const fishFreshness = freshness[fish.id] ?? 100;
          const prep = prepProgress[fish.id];
          const currentState: PrepState = prep?.state ?? "idle";
          const isDone = currentState === "done";
          const isRotten = fishFreshness <= 0;
          const isRare = fishData.reverseValue && fish.stageIndex === 0;

          const trendMult = marketTrend[fish.species] ?? 1;
          const freshMult = fishFreshness / 100;
          const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1;
          const qualityMultPremium = prep ? 0.8 + prep.avgAccuracy * 0.7 : 1;
          const instantPrice = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult);
          const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMultPremium);

          // アクティブフェーズの状態
          const active = activePhaseRef.current;
          const isActiveForThis = active?.fishId === fish.id;

          return (
            <div
              key={fish.id}
              className={`bg-white rounded-xl shadow-md p-4 ${
                isRotten ? "opacity-50" : ""
              } ${isRare ? "ring-2 ring-yellow-400" : ""}`}
            >
              {/* 魚情報ヘッダー */}
              <div className="flex justify-between items-center mb-2">
                <div>
                  <span className="font-bold text-lg">{fish.stageName}</span>
                  <span className="text-gray-500 text-sm ml-1">({fishData.displayName})</span>
                  {isRare && (
                    <span className="ml-1 text-xs bg-yellow-400 text-yellow-900 px-1.5 py-0.5 rounded-full font-bold">
                      超レア
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <span className="text-green-600 font-bold">¥{fish.sushiPrice.toLocaleString()}</span>
                  {isDone && prep && (
                    <span className={`block text-xs font-bold ${accuracyLabel(prep.avgAccuracy).color}`}>
                      {accuracyLabel(prep.avgAccuracy).icon} {accuracyLabel(prep.avgAccuracy).text}
                    </span>
                  )}
                </div>
              </div>

              {/* 鮮度ゲージ */}
              <div className="mb-3">
                <div className="flex justify-between text-xs mb-0.5">
                  <span>鮮度</span>
                  <span className={`font-bold ${fishFreshness > 50 ? "text-green-600" : fishFreshness > 20 ? "text-yellow-600" : "text-red-600"}`}>
                    {isRotten ? "まかない行き" : `${fishFreshness}%`}
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 rounded-full ${fishFreshness > 50 ? "bg-green-500" : fishFreshness > 20 ? "bg-yellow-500" : "bg-red-500"}`}
                    style={{ width: `${fishFreshness}%` }}
                  />
                </div>
              </div>

              {/* ステップインジケーター */}
              {!isRotten && !isDone && (
                <div className="flex items-center gap-1 mb-2">
                  {(["cut-entry","cut-slide","cut-belly","nigiri-rice","nigiri-pinch","nigiri-press"] as PrepState[]).map((step, i) => {
                    const stepLabels = ["切入","骨沿","腹骨","シャリ","合わせ","握り"];
                    const stepOrder = ["cut-entry","cut-slide","cut-belly","nigiri-rice","nigiri-pinch","nigiri-press"];
                    const currentIdx = stepOrder.indexOf(currentState);
                    const thisIdx = i;
                    const done = thisIdx < currentIdx;
                    const isCurrent = step === currentState;
                    return (
                      <div key={step} className="flex items-center">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold border-2 ${
                          done ? "bg-green-500 border-green-500 text-white" :
                          isCurrent ? "bg-blue-500 border-blue-500 text-white animate-pulse" :
                          "bg-gray-100 border-gray-300 text-gray-400"
                        }`}>
                          {done ? "✓" : stepLabels[i]}
                        </div>
                        {i < 5 && <div className={`w-2 h-0.5 ${done ? "bg-green-400" : "bg-gray-200"}`} />}
                      </div>
                    );
                  })}
                </div>
              )}

              {isRotten ? (
                <div className="text-center text-gray-400 text-sm py-2">鮮度が落ちてしまいました...</div>
              ) : (currentState === "idle" || currentState === "cut-entry") ? (
                /* ── 包丁を入れる（長押し）── */
                <CutEntryArea
                  fish={fish}
                  stage={stage}
                  isActive={isActiveForThis && active?.phase === "cut-entry"}
                  holdProgress={isActiveForThis ? active?.holdProgress ?? 0 : 0}
                  onStart={(e) => startCutEntry(fish, e)}
                  onMove={handleEntryMove}
                  onEnd={handleEntryEnd}
                />
              ) : currentState === "cut-slide" ? (
                /* ── 中骨スライド ── */
                <CutSlideArea
                  fish={fish}
                  isActive={isActiveForThis && active?.phase === "cut-slide"}
                  slidePoints={isActiveForThis ? active?.slidePoints : undefined}
                  speedZone={isActiveForThis ? active?.slideSpeedZone : undefined}
                  onStart={(e) => startSlide(fish, e)}
                  onMove={handleSlideMove}
                  onEnd={handleSlideEnd}
                />
              ) : currentState === "cut-belly" && (!prep || prep.state === "cut-belly") ? (
                /* ── 腹骨すく ── */
                <CutBellyArea
                  fish={fish}
                  isActive={isActiveForThis && active?.phase === "cut-belly"}
                  bellyArc={isActiveForThis ? active?.bellyArc : undefined}
                  bellyPoints={isActiveForThis ? active?.bellyPoints : undefined}
                  onStart={(e) => startBelly(fish, e)}
                  onMove={handleBellyMove}
                  onEnd={handleBellyEnd}
                />
              ) : currentState === "nigiri-rice" ? (
                /* ── シャリを取る ── */
                <NigiriRiceArea
                  fish={fish}
                  riceRatio={isActiveForThis ? active?.riceRatio ?? 0 : 0}
                  isActive={isActiveForThis && active?.phase === "nigiri-rice"}
                  onStart={(e) => startRice(fish, e)}
                  onEnd={() => handleRiceEnd(fish)}
                />
              ) : currentState === "nigiri-pinch" ? (
                /* ── ピンチ ── */
                <NigiriPinchArea
                  fish={fish}
                  isActive={isActiveForThis && active?.phase === "nigiri-pinch"}
                  pinchSamples={isActiveForThis ? active?.pinchSamples : undefined}
                  pinchStartDist={isActiveForThis ? active?.pinchStartDist : undefined}
                  onTouchStart={(e) => handlePinchStart(fish, e)}
                  onTouchMove={handlePinchMove}
                  onTouchEnd={() => handlePinchEnd(fish)}
                  onMouseDown={() => handlePinchMouseDown(fish)}
                  onMouseUp={() => handlePinchMouseUp(fish)}
                />
              ) : currentState === "nigiri-press" ? (
                /* ── 本手返し ── */
                <NigiriPressArea
                  fish={fish}
                  pressRatio={isActiveForThis ? active?.pressRatio ?? 0 : 0}
                  isActive={isActiveForThis && active?.phase === "nigiri-press"}
                  onStart={(e) => startPress(fish, e)}
                  onEnd={() => handlePressEnd(fish)}
                />
              ) : isDone ? (
                <div className="space-y-2">
                  <button
                    onClick={() => handleInstantSell(fish)}
                    className="w-full bg-blue-500 hover:bg-blue-600 text-white py-2.5 rounded-lg text-sm font-bold active:scale-95 transition-all flex items-center justify-between px-4"
                  >
                    <div className="text-left">
                      <span>即売り</span>
                      <span className="block text-xs opacity-80">確実・即金</span>
                    </div>
                    <span className="text-lg">¥{instantPrice.toLocaleString()}</span>
                  </button>
                  <button
                    onClick={() => handlePlaceOnCounter(fish)}
                    disabled={counterFull}
                    className={`w-full py-2.5 rounded-lg text-sm font-bold active:scale-95 transition-all flex items-center justify-between px-4 ${
                      counterFull ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-purple-500 hover:bg-purple-600 text-white"
                    }`}
                  >
                    <div className="text-left">
                      <span>限定メニュー</span>
                      <span className="block text-xs opacity-80">
                        {counterFull ? "カウンター満席" : "高単価・客待ちあり"}
                      </span>
                    </div>
                    <span className="text-lg">¥{premiumPrice.toLocaleString()}</span>
                  </button>
                </div>
              ) : null}

              {/* フェーズヒント */}
              {!isRotten && !isDone && currentState !== "idle" && (
                <div className="mt-1 text-center">
                  <span className="text-xs text-gray-500">{phaseHint(currentState)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// サブコンポーネント
// ════════════════════════════════════════════

// ── 包丁を入れる ──
interface CutEntryAreaProps {
  fish: CaughtFish;
  stage: { silhouetteScale: number };
  isActive: boolean;
  holdProgress: number;
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function CutEntryArea({ stage, isActive, holdProgress, onStart, onMove, onEnd }: CutEntryAreaProps) {
  return (
    <div
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={onEnd}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      {/* まな板テクスチャ */}
      <div className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)",
        }}
      />
      {/* 魚イラスト */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-5xl opacity-30" style={{ transform: `scale(${0.8 + stage.silhouetteScale * 0.4})` }}>
          🐟
        </div>
      </div>

      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* 切り込みターゲット */}
        <circle
          cx={ENTRY_CIRCLE_X} cy={ENTRY_CIRCLE_Y} r={ENTRY_CIRCLE_R}
          fill="none" stroke={isActive ? "#ef4444" : "#3b82f6"}
          strokeWidth={3} strokeDasharray={isActive ? "none" : "6,4"}
          className={isActive ? "" : "animate-pulse"}
        />
        {/* プログレスリング */}
        {isActive && holdProgress > 0 && (
          <circle
            cx={ENTRY_CIRCLE_X} cy={ENTRY_CIRCLE_Y} r={ENTRY_CIRCLE_R}
            fill="none" stroke="#ef4444" strokeWidth={4}
            strokeDasharray={`${holdProgress * Math.PI * 2 * ENTRY_CIRCLE_R} ${Math.PI * 2 * ENTRY_CIRCLE_R}`}
            strokeDashoffset={Math.PI * 0.5 * ENTRY_CIRCLE_R}
            strokeLinecap="round"
          />
        )}
        {/* 包丁アイコン */}
        <text
          x={ENTRY_CIRCLE_X} y={ENTRY_CIRCLE_Y + 5}
          textAnchor="middle" fontSize={18}
        >
          🔪
        </text>
        {/* 矢印（頭→体方向を示す） */}
        <line x1={ENTRY_CIRCLE_X + ENTRY_CIRCLE_R + 10} y1={ENTRY_CIRCLE_Y}
              x2={AREA_W - 40} y2={ENTRY_CIRCLE_Y}
              stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5,5" />
        <polygon
          points={`${AREA_W - 45},${ENTRY_CIRCLE_Y - 5} ${AREA_W - 35},${ENTRY_CIRCLE_Y} ${AREA_W - 45},${ENTRY_CIRCLE_Y + 5}`}
          fill="#94a3b8"
        />
      </svg>

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive ? `包丁を入れています... ${Math.round(holdProgress * 100)}%` : "頭の付け根を長押し"}
        </span>
      </div>
    </div>
  );
}

// ── 中骨スライド ──
interface CutSlideAreaProps {
  fish: CaughtFish;
  isActive: boolean;
  slidePoints?: { x: number; y: number; t: number }[];
  speedZone?: "slow" | "ideal" | "fast";
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function CutSlideArea({ isActive, slidePoints, speedZone, onStart, onMove, onEnd }: CutSlideAreaProps) {
  const zoneColor = speedZone === "fast" ? "#ef4444" : speedZone === "ideal" ? "#22c55e" : "#94a3b8";
  const zoneLabel = speedZone === "fast" ? "速すぎる！" : speedZone === "ideal" ? "スルスル..." : "ゆっくり...";
  const progress = slidePoints && slidePoints.length > 0
    ? Math.min(1, (slidePoints[slidePoints.length - 1].x - BONE_START_X) / (BONE_END_X - BONE_START_X))
    : 0;

  return (
    <div
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={() => { if (isActive) onEnd(); }}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      <div className="absolute inset-0 opacity-30"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)" }}
      />

      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* 中骨ライン（少し波打つ） */}
        <path
          d={`M ${BONE_START_X} ${BONE_Y} Q ${AREA_W * 0.35} ${BONE_Y - 3} ${AREA_W / 2} ${BONE_Y} Q ${AREA_W * 0.65} ${BONE_Y + 3} ${BONE_END_X} ${BONE_Y}`}
          fill="none"
          stroke={isActive ? zoneColor : "#64748b"}
          strokeWidth={isActive ? 4 : 3}
          strokeDasharray={isActive ? "none" : "8,5"}
          strokeLinecap="round"
        />
        {/* 骨の模様（小さな横棒） */}
        {Array.from({ length: 8 }).map((_, i) => {
          const x = BONE_START_X + (BONE_END_X - BONE_START_X) * ((i + 1) / 9);
          return (
            <line key={i}
              x1={x} y1={BONE_Y - 8} x2={x} y2={BONE_Y + 8}
              stroke="rgba(100,116,139,0.3)" strokeWidth={1.5}
            />
          );
        })}

        {/* 始点マーカー */}
        <circle cx={BONE_START_X} cy={BONE_Y} r={10}
          fill={isActive ? zoneColor : "#dbeafe"} stroke={isActive ? zoneColor : "#3b82f6"}
          strokeWidth={2} className={isActive ? "" : "animate-pulse"}
        />
        <text x={BONE_START_X} y={BONE_Y + 3.5} textAnchor="middle" fontSize={8} fontWeight="bold"
          fill={isActive ? "#fff" : "#1e40af"}>始</text>

        {/* 終点マーカー */}
        <circle cx={BONE_END_X} cy={BONE_Y} r={8}
          fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="3,3"
        />

        {/* プレイヤーの軌跡 */}
        {slidePoints && slidePoints.length > 1 && (
          <polyline
            points={slidePoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke="rgba(220,50,50,0.7)" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}
      </svg>

      {/* 速度インジケーター */}
      {isActive && (
        <div className="absolute top-2 right-2">
          <div className={`text-xs font-bold px-2 py-0.5 rounded-full ${
            speedZone === "fast" ? "bg-red-500 text-white animate-pulse" :
            speedZone === "ideal" ? "bg-green-500 text-white" :
            "bg-gray-300 text-gray-600"
          }`}>
            {zoneLabel}
          </div>
        </div>
      )}

      {/* 進捗バー */}
      {isActive && (
        <div className="absolute top-2 left-2 w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive ? "骨に沿ってゆっくり..." : "左の始点からスワイプ開始"}
        </span>
      </div>
    </div>
  );
}

// ── 腹骨すく ──
interface CutBellyAreaProps {
  fish: CaughtFish;
  isActive: boolean;
  bellyArc?: { x: number; y: number }[];
  bellyPoints?: { x: number; y: number }[];
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function CutBellyArea({ fish, isActive, bellyArc, bellyPoints, onStart, onMove, onEnd }: CutBellyAreaProps) {
  const fishData = FISH_DATABASE[fish.species];
  const stage = fishData.stages[fish.stageIndex];
  const arc = bellyArc ?? generateBellyArc(stage.prepDifficulty);

  return (
    <div
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={() => { if (isActive) onEnd(); }}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      <div className="absolute inset-0 opacity-30"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)" }}
      />

      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* 腹骨の弧ガイドライン */}
        <polyline
          points={arc.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={isActive ? "#f59e0b" : "#3b82f6"}
          strokeWidth={isActive ? 3.5 : 3}
          strokeDasharray={isActive ? "none" : "6,4"}
          strokeLinecap="round"
        />

        {/* 始点マーカー */}
        <circle cx={arc[0].x} cy={arc[0].y} r={10}
          fill={isActive ? "#f59e0b" : "#dbeafe"} stroke={isActive ? "#f59e0b" : "#3b82f6"}
          strokeWidth={2} className={isActive ? "" : "animate-pulse"}
        />
        <text x={arc[0].x} y={arc[0].y + 3.5} textAnchor="middle" fontSize={8} fontWeight="bold"
          fill={isActive ? "#fff" : "#1e40af"}>始</text>

        {/* 終点マーカー */}
        <circle cx={arc[arc.length - 1].x} cy={arc[arc.length - 1].y} r={8}
          fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="3,3"
        />

        {/* プレイヤーの軌跡 */}
        {bellyPoints && bellyPoints.length > 1 && (
          <polyline
            points={bellyPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke="rgba(245,158,11,0.7)" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* 魚体の輪郭（腹部ハイライト） */}
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 - 8} rx={90} ry={35}
          fill="none" stroke="rgba(100,116,139,0.15)" strokeWidth={1.5}
        />
      </svg>

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive ? "腹骨に沿って丁寧に..." : "弧の始点からスワイプ"}
        </span>
      </div>
    </div>
  );
}

// ── シャリを取る ──
interface NigiriRiceAreaProps {
  fish: CaughtFish;
  riceRatio: number;
  isActive: boolean;
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function NigiriRiceArea({ fish, riceRatio, isActive, onStart, onEnd }: NigiriRiceAreaProps) {
  const fishData = FISH_DATABASE[fish.species];
  const stage = fishData.stages[fish.stageIndex];
  const idealRatio = getIdealRiceRatio(stage.size);
  const idealMin = idealRatio - 0.08;
  const idealMax = idealRatio + 0.08;
  const inIdealZone = riceRatio >= idealMin && riceRatio <= idealMax;

  // シャリの表示サイズ
  const riceSize = 20 + riceRatio * 50;

  return (
    <div
      className="relative bg-gradient-to-b from-yellow-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200 cursor-pointer"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseUp={onEnd}
      onTouchStart={(e) => { e.preventDefault(); onStart(e); }}
      onTouchEnd={onEnd}
    >
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* シャリ桶 */}
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 + 20} rx={60} ry={25}
          fill="#fef3c7" stroke="#d97706" strokeWidth={2}
        />
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 + 10} rx={60} ry={25}
          fill="#fffbeb" stroke="#d97706" strokeWidth={2}
        />
        {/* シャリの粒感 */}
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i / 12) * Math.PI * 2;
          return (
            <circle key={i}
              cx={AREA_W / 2 + Math.cos(angle) * 35}
              cy={AREA_H / 2 + 10 + Math.sin(angle) * 14}
              r={2} fill="rgba(217,119,6,0.25)"
            />
          );
        })}

        {/* 成長するシャリ玉 */}
        {isActive && (
          <ellipse
            cx={AREA_W / 2} cy={AREA_H / 2 - 20}
            rx={riceSize * 0.7} ry={riceSize * 0.4}
            fill={inIdealZone ? "#86efac" : "#fffbeb"}
            stroke={inIdealZone ? "#16a34a" : "#d97706"}
            strokeWidth={2}
          />
        )}

        {/* サイズゲージ */}
        <rect x={AREA_W - 25} y={15} width={10} height={AREA_H - 30}
          fill="#e5e7eb" rx={5}
        />
        {/* 理想ゾーン */}
        <rect
          x={AREA_W - 25}
          y={15 + (AREA_H - 30) * (1 - idealMax)}
          width={10}
          height={(AREA_H - 30) * (idealMax - idealMin)}
          fill="#86efac" rx={2}
        />
        {/* 現在値 */}
        {isActive && (
          <circle
            cx={AREA_W - 20}
            cy={15 + (AREA_H - 30) * (1 - riceRatio)}
            r={5}
            fill={inIdealZone ? "#16a34a" : "#d97706"}
            stroke="#fff" strokeWidth={1.5}
          />
        )}

        {/* サイズラベル */}
        <text x={AREA_W - 20} y={12} textAnchor="middle" fontSize={7} fill="#6b7280">大</text>
        <text x={AREA_W - 20} y={AREA_H - 2} textAnchor="middle" fontSize={7} fill="#6b7280">小</text>
      </svg>

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive
            ? (inIdealZone ? "今だ！離して取る！" : `シャリを握り中... ${Math.round(riceRatio * 100)}%`)
            : `タップ長押しでシャリを取る（${stage.size === "small" ? "小さめ" : stage.size === "large" ? "大きめ" : "中くらい"}が理想）`
          }
        </span>
      </div>
    </div>
  );
}

// ── ピンチ ──
interface NigiriPinchAreaProps {
  fish: CaughtFish;
  isActive: boolean;
  pinchSamples?: number[];
  pinchStartDist?: number;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
}

function NigiriPinchArea({ isActive, pinchSamples, pinchStartDist, onTouchStart, onTouchMove, onTouchEnd, onMouseDown, onMouseUp }: NigiriPinchAreaProps) {
  const progress = isActive && pinchSamples && pinchStartDist && pinchSamples.length > 0
    ? Math.max(0, Math.min(1, 1 - pinchSamples[pinchSamples.length - 1] / pinchStartDist))
    : 0;

  // ネタとシャリの間隔（ピンチで閉じる）
  const gap = 30 * (1 - progress);

  return (
    <div
      className="relative bg-gradient-to-b from-orange-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200 cursor-pointer"
      style={{ height: AREA_H }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* ネタ（上） */}
        <ellipse
          cx={AREA_W / 2} cy={AREA_H / 2 - gap / 2 - 12}
          rx={45} ry={14}
          fill="#fb923c" stroke="#ea580c" strokeWidth={1.5}
        />
        <text x={AREA_W / 2} y={AREA_H / 2 - gap / 2 - 10}
          textAnchor="middle" fontSize={8} fill="#7c2d12">ネタ</text>

        {/* シャリ（下） */}
        <ellipse
          cx={AREA_W / 2} cy={AREA_H / 2 + gap / 2 + 12}
          rx={40} ry={16}
          fill="#fffbeb" stroke="#d97706" strokeWidth={1.5}
        />
        <text x={AREA_W / 2} y={AREA_H / 2 + gap / 2 + 14}
          textAnchor="middle" fontSize={8} fill="#92400e">シャリ</text>

        {/* ピンチ矢印（閉じる方向） */}
        {!isActive && (
          <>
            {/* 左手指イメージ */}
            <text x={AREA_W / 2 - 55} y={AREA_H / 2 + 5} fontSize={20}>👆</text>
            <line x1={AREA_W / 2 - 40} y1={AREA_H / 2}
                  x2={AREA_W / 2 - 15} y2={AREA_H / 2}
                  stroke="#3b82f6" strokeWidth={2} markerEnd="url(#arrowBlue)" />
            {/* 右手指イメージ */}
            <text x={AREA_W / 2 + 38} y={AREA_H / 2 + 5} fontSize={20}>👆</text>
            <line x1={AREA_W / 2 + 40} y1={AREA_H / 2}
                  x2={AREA_W / 2 + 15} y2={AREA_H / 2}
                  stroke="#3b82f6" strokeWidth={2} markerEnd="url(#arrowBlue)" />
            <defs>
              <marker id="arrowBlue" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0,0 8,3 0,6" fill="#3b82f6" />
              </marker>
            </defs>
          </>
        )}

        {/* 進捗リング */}
        {isActive && (
          <circle
            cx={AREA_W / 2} cy={AREA_H / 2}
            r={35} fill="none"
            stroke="#22c55e" strokeWidth={3}
            strokeDasharray={`${progress * Math.PI * 70} ${Math.PI * 70}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${AREA_W / 2} ${AREA_H / 2})`}
          />
        )}
      </svg>

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive
            ? `合わせ中... ${Math.round(progress * 100)}%`
            : "二本指で挟んで合わせる（PCはクリック）"
          }
        </span>
      </div>
    </div>
  );
}

// ── 本手返し（圧力ゲージ） ──
interface NigiriPressAreaProps {
  fish: CaughtFish;
  pressRatio: number;
  isActive: boolean;
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function NigiriPressArea({ fish, pressRatio, isActive, onStart, onEnd }: NigiriPressAreaProps) {
  const fishData = FISH_DATABASE[fish.species];
  const stage = fishData.stages[fish.stageIndex];
  const [lo, hi] = getIdealPressRange(stage.size);
  const inSweet = pressRatio >= lo && pressRatio <= hi;
  const tooSoft = pressRatio < lo;

  // 寿司の見た目（圧で形が変わる）
  const squish = 1 + pressRatio * 0.3; // 横に広がる
  const squishY = 1 - pressRatio * 0.15; // 縦が縮む

  return (
    <div
      className="relative bg-gradient-to-b from-yellow-50 to-orange-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200 cursor-pointer"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseUp={onEnd}
      onTouchStart={(e) => { e.preventDefault(); onStart(e); }}
      onTouchEnd={onEnd}
    >
      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${AREA_W} ${AREA_H}`}>
        {/* 圧力ゲージ（左側） */}
        <rect x={15} y={15} width={14} height={AREA_H - 30}
          fill="#e5e7eb" rx={7}
        />
        {/* スイートスポットゾーン */}
        <rect
          x={15}
          y={15 + (AREA_H - 30) * (1 - hi)}
          width={14}
          height={(AREA_H - 30) * (hi - lo)}
          fill="rgba(34,197,94,0.5)" rx={3}
        />
        {/* 現在の圧力 */}
        <rect
          x={15}
          y={15 + (AREA_H - 30) * (1 - pressRatio)}
          width={14}
          height={Math.max(2, (AREA_H - 30) * pressRatio)}
          fill={inSweet ? "#22c55e" : pressRatio > hi ? "#ef4444" : "#fbbf24"}
          rx={3}
        />
        {/* ゲージラベル */}
        <text x={22} y={12} textAnchor="middle" fontSize={7} fill="#6b7280">強</text>
        <text x={22} y={AREA_H - 2} textAnchor="middle" fontSize={7} fill="#6b7280">弱</text>

        {/* 寿司 */}
        <g transform={`translate(${AREA_W / 2}, ${AREA_H / 2 + 5})`}>
          {/* シャリ */}
          <ellipse cx={0} cy={8} rx={35 * squish} ry={18 * squishY}
            fill="#fffbeb" stroke="#d97706" strokeWidth={1.5}
          />
          {/* ネタ */}
          <ellipse cx={0} cy={-5} rx={38 * squish} ry={12 * squishY}
            fill="#fb923c" stroke="#ea580c" strokeWidth={1.5}
          />
          {/* 光沢 */}
          <ellipse cx={-8} cy={-8} rx={12} ry={4}
            fill="rgba(255,255,255,0.3)"
          />
        </g>

        {/* 状態テキスト */}
        {isActive && (
          <text
            x={AREA_W / 2} y={25}
            textAnchor="middle" fontSize={13} fontWeight="bold"
            fill={inSweet ? "#16a34a" : pressRatio > hi ? "#dc2626" : "#d97706"}
          >
            {inSweet ? "今だ！離す！" : tooSoft ? "もう少し..." : "強すぎ！"}
          </text>
        )}

        {/* 手のアイコン */}
        {!isActive && (
          <text x={AREA_W / 2} y={AREA_H / 2 + 6} textAnchor="middle" fontSize={24}>🤲</text>
        )}
      </svg>

      <div className="absolute bottom-1.5 left-0 right-0 text-center">
        <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
          {isActive
            ? `圧 ${Math.round(pressRatio * 100)}% — ${inSweet ? "完璧な圧！離せ！" : tooSoft ? "もっと押す..." : "強すぎる！早く離せ！"}`
            : "長押しして握る — 緑のゾーンで離す"
          }
        </span>
      </div>
    </div>
  );
}
