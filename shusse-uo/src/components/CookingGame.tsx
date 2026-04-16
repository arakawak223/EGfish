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
const ENTRY_HOLD_MS = 600;
const ENTRY_CIRCLE_X = 55;
const ENTRY_CIRCLE_Y = AREA_H / 2;
const ENTRY_CIRCLE_R = 32;        // ★ 拡大

const BONE_START_X = 40;
const BONE_END_X = AREA_W - 30;
const BONE_Y = AREA_H / 2 - 5;
const SLIDE_IDEAL_MIN = 40;       // ★ 緩和
const SLIDE_IDEAL_MAX = 220;      // ★ 緩和
const SLIDE_TOO_FAST = 320;       // ★ 緩和

const BELLY_ARC_POINTS = 20;

// ── 握りパラメータ ──
const RICE_MAX_HOLD_MS = 1800;
const PINCH_INITIAL_DIST = 100;
const PINCH_COMPLETE_DIST = 25;
const PRESS_MAX_MS = 2200;

function getIdealRiceRatio(size: "small" | "medium" | "large"): number {
  switch (size) {
    case "small": return 0.28;
    case "medium": return 0.50;
    case "large": return 0.68;
  }
}

function getIdealPressRange(size: "small" | "medium" | "large"): [number, number] {
  switch (size) {
    case "small": return [0.18, 0.45];
    case "medium": return [0.30, 0.62];
    case "large": return [0.42, 0.75];
  }
}

function generateBellyArc(difficulty: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  const startX = AREA_W * 0.65;
  const startY = AREA_H * 0.32;
  const endX = AREA_W * 0.25;
  const endY = AREA_H * 0.78;
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
  return Math.max(0, Math.min(1, 1 - avgDist / 35));
}

function scorePinch(samples: number[]): number {
  if (samples.length < 3) return 0;
  const start = samples[0];
  const end = samples[samples.length - 1];
  const closedRatio = Math.max(0, Math.min(1, (start - end) / (start * 0.6)));
  let monotone = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] <= samples[i - 1] + 5) monotone++;
  }
  const smoothness = monotone / (samples.length - 1);
  return closedRatio * 0.6 + smoothness * 0.4;
}

// ── チュートリアルガイド ──
const TUTORIAL_STEPS = [
  { icon: "🔪", title: "1. 包丁を入れる", desc: "頭の付け根の円を長押し" },
  { icon: "🦴", title: "2. 中骨に沿う",   desc: "骨ラインをゆっくり右へスワイプ" },
  { icon: "🔻", title: "3. 腹骨をすく",   desc: "弧のガイドに沿ってスワイプ" },
  { icon: "🍚", title: "4. シャリを取る", desc: "長押し → 緑ゾーンで離す" },
  { icon: "🤏", title: "5. ネタと合わせ", desc: "二本指ピンチ（PCはクリック）" },
  { icon: "🤲", title: "6. 本手返し",     desc: "長押し → 緑ゾーンで離す" },
];

function TutorialGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-blue-800">調理ガイド — 6つの工程で握りを完成させよう！</span>
        <button
          onClick={onClose}
          className="text-xs bg-blue-500 text-white px-3 py-1 rounded-full font-bold active:scale-95"
        >
          閉じる
        </button>
      </div>

      {/* 三枚おろし */}
      <div className="mb-2">
        <span className="text-xs font-bold text-orange-700 bg-orange-100 px-2 py-0.5 rounded">三枚おろし</span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {TUTORIAL_STEPS.slice(0, 3).map((step, i) => (
          <div key={i} className="bg-white rounded-lg p-2 text-center border border-orange-200">
            <div className="text-2xl mb-1">{step.icon}</div>
            <div className="text-[10px] font-bold text-gray-700">{step.title}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">{step.desc}</div>
          </div>
        ))}
      </div>

      {/* 握り */}
      <div className="mb-2">
        <span className="text-xs font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded">握り</span>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {TUTORIAL_STEPS.slice(3).map((step, i) => (
          <div key={i} className="bg-white rounded-lg p-2 text-center border border-green-200">
            <div className="text-2xl mb-1">{step.icon}</div>
            <div className="text-[10px] font-bold text-gray-700">{step.title}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">{step.desc}</div>
          </div>
        ))}
      </div>

      <div className="text-center">
        <div className="text-[10px] text-blue-600 bg-blue-100 rounded-full px-3 py-1 inline-block">
          速すぎるスワイプ = 身を削る！ゆっくり丁寧に操作しましょう
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// メインコンポーネント
// ════════════════════════════════════════════

export default function CookingGame({
  inventory, marketTrend, onSell, timeMultiplier = 1, paused = false,
}: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [counter, setCounter] = useState<CounterItem[]>([]);
  const [showTutorial, setShowTutorial] = useState(true);
  const [, setTick] = useState(0);
  const forceTick = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);

  const activePhaseRef = useRef<{
    fishId: string;
    phase: PrepState;
    startTime: number;
    holdProgress?: number;
    holdInCircle?: boolean;
    slidePoints?: { x: number; y: number; t: number }[];
    slideVelocities?: number[];
    slideLastVibTime?: number;
    slideSpeedZone?: "slow" | "ideal" | "fast";
    bellyArc?: { x: number; y: number }[];
    bellyPoints?: { x: number; y: number }[];
    riceRatio?: number;
    pinchSamples?: number[];
    pinchStartDist?: number;
    pinchComplete?: boolean;
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

  // ── アニメーションループ ──
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
            vibrate(HAPTIC_PATTERNS.knifeEntry);
            playSEKnifeEntry();
            const fishId = active.fishId;
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
          }
          forceTick();
        }

        if (active.phase === "nigiri-rice") {
          active.riceRatio = Math.min(1, elapsed / (RICE_MAX_HOLD_MS * timeMultiplier));
          forceTick();
        }

        if (active.phase === "nigiri-press") {
          active.pressRatio = Math.min(1, elapsed / (PRESS_MAX_MS * timeMultiplier));
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

  // ★ 修正: タッチイベントからクライアント座標を取得（touchend対応）
  const getClientPos = (e: React.MouseEvent | React.TouchEvent) => {
    if ("touches" in e) {
      if (e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if ("changedTouches" in e && (e as React.TouchEvent).changedTouches.length > 0) {
        return { x: (e as React.TouchEvent).changedTouches[0].clientX, y: (e as React.TouchEvent).changedTouches[0].clientY };
      }
      return null;
    }
    if ("clientX" in e) return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
    return null;
  };

  // ★ 修正: preserveAspectRatio="none" と合わせた正確な座標変換
  const toRelative = (clientX: number, clientY: number) => {
    const rect = activeRectRef.current;
    if (!rect) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * AREA_W,
      y: ((clientY - rect.top) / rect.height) * AREA_H,
    };
  };

  // ── 1. 包丁を入れる ──

  const startCutEntry = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    // ★ ヒットゾーン大幅拡大: エリア左半分ならどこでもOK
    if (pos.x > AREA_W * 0.5) return;

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
    // エリア内にいればOK（指がずれても許容）
    const dist = Math.hypot(pos.x - ENTRY_CIRCLE_X, pos.y - ENTRY_CIRCLE_Y);
    if (dist > ENTRY_CIRCLE_R * 3) {
      active.holdInCircle = false;
    }
  }, []);

  const handleEntryEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-entry") return;
    activePhaseRef.current = null;
    forceTick();
  }, [forceTick]);

  // ── 2. 中骨スライド ──

  const startSlide = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    // ★ 開始判定を大幅緩和: 左1/3ならどこでも開始可能
    if (pos.x > AREA_W * 0.4) return;

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
    const dt = (now - prev.t) / 1000;
    if (dt < 0.01) return;

    const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y);
    const velocity = dist / dt;

    active.slidePoints.push({ ...pos, t: now });
    active.slideVelocities!.push(velocity);

    const adjustedMax = SLIDE_IDEAL_MAX * (1 + (1 - timeMultiplier) * 0.3);
    const adjustedFast = SLIDE_TOO_FAST * (1 + (1 - timeMultiplier) * 0.3);
    const vibInterval = 120;

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

    // ★ 完了判定を緩和: 右2/3まで来たらOK
    if (pos.x >= AREA_W * 0.7) {
      const velocities = active.slideVelocities!;
      let idealCount = 0;
      let fastCount = 0;
      for (const v of velocities) {
        if (v >= SLIDE_IDEAL_MIN && v <= adjustedMax) idealCount++;
        if (v > adjustedFast) fastCount++;
      }
      const idealRatio = velocities.length > 0 ? idealCount / velocities.length : 0;
      const fastPenalty = velocities.length > 0 ? fastCount / velocities.length : 0;
      const pts = active.slidePoints!;
      let totalDeviation = 0;
      for (const p of pts) {
        totalDeviation += Math.abs(p.y - BONE_Y);
      }
      const avgDeviation = totalDeviation / pts.length;
      const pathAcc = Math.max(0, Math.min(1, 1 - avgDeviation / 35));

      const slideScore = Math.max(0, Math.min(1,
        idealRatio * 0.5 + pathAcc * 0.35 - fastPenalty * 0.3 + 0.15
      ));

      const fishId = active.fishId;
      playSESlice();
      vibrate([20, 8, 12]);
      activePhaseRef.current = null;

      setPrepProgress((prev) => {
        const p = prev[fishId] ?? makeInitialPrep(fishId);
        return { ...prev, [fishId]: { ...p, state: "cut-belly", slideScore } };
      });
    }

    forceTick();
  }, [timeMultiplier, forceTick]);

  const handleSlideEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-slide") return;
    // 途中で離した → 進行度に応じたスコア
    const pts = active.slidePoints ?? [];
    const progress = pts.length > 0 ? Math.min(1, (pts[pts.length - 1].x - BONE_START_X) / (BONE_END_X - BONE_START_X)) : 0;
    const slideScore = Math.max(0.1, progress * 0.5);
    const fishId = active.fishId;
    activePhaseRef.current = null;
    setPrepProgress((prev) => {
      const p = prev[fishId] ?? makeInitialPrep(fishId);
      return { ...prev, [fishId]: { ...p, state: "cut-belly", slideScore } };
    });
    forceTick();
  }, [forceTick]);

  // ── 3. 腹骨すく ──

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

    // ★ 開始判定を大幅緩和: 弧の始点から50px以内
    const distToStart = Math.hypot(pos.x - arc[0].x, pos.y - arc[0].y);
    if (distToStart > 55) return;

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

    const arcEnd = active.bellyArc[active.bellyArc.length - 1];
    const distToEnd = Math.hypot(pos.x - arcEnd.x, pos.y - arcEnd.y);

    // ★ 完了判定を緩和
    if (distToEnd < 45 && active.bellyPoints!.length >= 4) {
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
    }
    forceTick();
  }, [forceTick]);

  const handleBellyEnd = useCallback(() => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "cut-belly") return;
    const fishId = active.fishId;
    const bellyScore = active.bellyPoints && active.bellyArc
      ? Math.max(0.2, scoreArcFollowing(active.bellyPoints, active.bellyArc) * 0.6)
      : 0.15;
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

  // ── 4. シャリを取る ──

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

    const diff = Math.abs(ratio - idealRatio);
    const riceScore = Math.max(0, Math.min(1, 1 - diff / 0.35));

    playSERiceGrab();
    vibrate(HAPTIC_PATTERNS.riceGrab);
    activePhaseRef.current = null;

    setPrepProgress((prev) => {
      const p = prev[fish.id] ?? makeInitialPrep(fish.id);
      return { ...prev, [fish.id]: { ...p, state: "nigiri-pinch", riceScore } };
    });
    forceTick();
  }, [forceTick]);

  // ── 5. ネタと合わせる（ピンチ / クリック） ──

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
    const pinchScore = active.pinchSamples && active.pinchSamples.length > 2
      ? scorePinch(active.pinchSamples) * 0.7
      : 0.3;
    finishPinch(fish.id, pinchScore);
  }, []);

  // PC用: クリックで合わせ完了
  const handlePinchClick = useCallback((fish: CaughtFish) => {
    if (activePhaseRef.current?.phase === "nigiri-pinch") return;
    const pinchScore = 0.75;
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
    forceTick();
  }

  // ── 6. 本手返し ──

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
        const center = (lo + hi) / 2;
        const halfRange = (hi - lo) / 2;
        pressScore = 1 - Math.abs(ratio - center) / halfRange * 0.15;
      } else {
        const distToRange = ratio < lo ? lo - ratio : ratio - hi;
        pressScore = Math.max(0, 1 - distToRange / 0.4);
      }
      pressScore = Math.max(0, Math.min(1, pressScore));

      const nigiriAcc = Math.min(1,
        p.riceScore * 0.30 + p.pinchScore * 0.25 + pressScore * 0.45
      );
      const finalAcc = Math.min(1, p.cutAccuracy * 0.55 + nigiriAcc * 0.45);
      const perfectAll = finalAcc >= 0.82;

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

  const stepLabels = ["切入","骨沿","腹骨","シャリ","合わせ","握り"];
  const stepOrder: PrepState[] = ["cut-entry","cut-slide","cut-belly","nigiri-rice","nigiri-pinch","nigiri-press"];

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
      {/* チュートリアルガイド */}
      {showTutorial && <TutorialGuide onClose={() => setShowTutorial(false)} />}

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

      {/* ガイド再表示ボタン */}
      {!showTutorial && (
        <div className="mb-2 text-right">
          <button
            onClick={() => setShowTutorial(true)}
            className="text-[10px] text-blue-500 underline"
          >
            操作ガイドを表示
          </button>
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
                  {stepOrder.map((step, i) => {
                    const currentIdx = stepOrder.indexOf(currentState);
                    const done = i < currentIdx;
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
                <CutEntryArea
                  stage={stage}
                  isActive={isActiveForThis && active?.phase === "cut-entry"}
                  holdProgress={isActiveForThis ? active?.holdProgress ?? 0 : 0}
                  onStart={(e) => startCutEntry(fish, e)}
                  onMove={handleEntryMove}
                  onEnd={handleEntryEnd}
                />
              ) : currentState === "cut-slide" ? (
                <CutSlideArea
                  isActive={isActiveForThis && active?.phase === "cut-slide"}
                  slidePoints={isActiveForThis ? active?.slidePoints : undefined}
                  speedZone={isActiveForThis ? active?.slideSpeedZone : undefined}
                  onStart={(e) => startSlide(fish, e)}
                  onMove={handleSlideMove}
                  onEnd={handleSlideEnd}
                />
              ) : currentState === "cut-belly" && (!prep || prep.state === "cut-belly") ? (
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
                <NigiriRiceArea
                  fish={fish}
                  riceRatio={isActiveForThis ? active?.riceRatio ?? 0 : 0}
                  isActive={isActiveForThis && active?.phase === "nigiri-rice"}
                  onStart={(e) => startRice(fish, e)}
                  onEnd={() => handleRiceEnd(fish)}
                />
              ) : currentState === "nigiri-pinch" ? (
                <NigiriPinchArea
                  isActive={isActiveForThis && active?.phase === "nigiri-pinch"}
                  pinchSamples={isActiveForThis ? active?.pinchSamples : undefined}
                  pinchStartDist={isActiveForThis ? active?.pinchStartDist : undefined}
                  onTouchStart={(e) => handlePinchStart(fish, e)}
                  onTouchMove={handlePinchMove}
                  onTouchEnd={() => handlePinchEnd(fish)}
                  onClick={() => handlePinchClick(fish)}
                />
              ) : currentState === "nigiri-press" ? (
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
// サブコンポーネント — 全SVGに preserveAspectRatio="none" を追加
// ════════════════════════════════════════════

const SVG_PROPS = {
  className: "absolute inset-0 w-full h-full pointer-events-none",
  viewBox: `0 0 ${AREA_W} ${AREA_H}`,
  preserveAspectRatio: "none",
} as const;

const BOARD_BG = "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)";

// ── 1. 包丁を入れる ──
interface CutEntryAreaProps {
  stage: { silhouetteScale: number };
  isActive: boolean;
  holdProgress: number;
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function CutEntryArea({ stage, isActive, holdProgress, onStart, onMove, onEnd }: CutEntryAreaProps) {
  const circumference = Math.PI * 2 * ENTRY_CIRCLE_R;

  return (
    <div
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border-2 border-amber-300"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={onEnd}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      <div className="absolute inset-0 opacity-30" style={{ backgroundImage: BOARD_BG }} />

      {/* 魚イラスト */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-5xl opacity-25" style={{ transform: `scale(${0.8 + stage.silhouetteScale * 0.4})` }}>
          🐟
        </div>
      </div>

      <svg {...SVG_PROPS}>
        {/* 操作ゾーン表示（左半分をハイライト） */}
        <rect x={0} y={0} width={AREA_W / 2} height={AREA_H}
          fill={isActive ? "rgba(239,68,68,0.08)" : "rgba(59,130,246,0.06)"}
        />

        {/* 包丁ターゲット円 */}
        <circle
          cx={ENTRY_CIRCLE_X} cy={ENTRY_CIRCLE_Y} r={ENTRY_CIRCLE_R}
          fill={isActive ? "rgba(239,68,68,0.15)" : "rgba(59,130,246,0.1)"}
          stroke={isActive ? "#ef4444" : "#3b82f6"}
          strokeWidth={3} strokeDasharray={isActive ? "none" : "6,4"}
          className={isActive ? "" : "animate-pulse"}
        />

        {/* プログレスリング */}
        {isActive && holdProgress > 0 && (
          <circle
            cx={ENTRY_CIRCLE_X} cy={ENTRY_CIRCLE_Y} r={ENTRY_CIRCLE_R}
            fill="none" stroke="#ef4444" strokeWidth={5}
            strokeDasharray={`${holdProgress * circumference} ${circumference}`}
            strokeDashoffset={circumference * 0.25}
            strokeLinecap="round"
          />
        )}

        {/* 包丁アイコン */}
        <text x={ENTRY_CIRCLE_X} y={ENTRY_CIRCLE_Y + 6} textAnchor="middle" fontSize={22}>🔪</text>

        {/* 矢印 */}
        <line x1={ENTRY_CIRCLE_X + ENTRY_CIRCLE_R + 12} y1={ENTRY_CIRCLE_Y}
              x2={AREA_W - 40} y2={ENTRY_CIRCLE_Y}
              stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5,5" />
        <polygon
          points={`${AREA_W - 45},${ENTRY_CIRCLE_Y - 5} ${AREA_W - 35},${ENTRY_CIRCLE_Y} ${AREA_W - 45},${ENTRY_CIRCLE_Y + 5}`}
          fill="#94a3b8"
        />
      </svg>

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? "bg-red-500 text-white" : "bg-blue-500 text-white animate-pulse"
        }`}>
          {isActive ? `包丁を入れています... ${Math.round(holdProgress * 100)}%` : "🔪 左側を長押しして包丁を入れる"}
        </span>
      </div>
    </div>
  );
}

// ── 2. 中骨スライド ──
interface CutSlideAreaProps {
  isActive: boolean;
  slidePoints?: { x: number; y: number; t: number }[];
  speedZone?: "slow" | "ideal" | "fast";
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function CutSlideArea({ isActive, slidePoints, speedZone, onStart, onMove, onEnd }: CutSlideAreaProps) {
  const zoneColor = speedZone === "fast" ? "#ef4444" : speedZone === "ideal" ? "#22c55e" : "#94a3b8";
  const zoneLabel = speedZone === "fast" ? "速すぎる！身が削れる！" : speedZone === "ideal" ? "スルスル...完璧！" : "";
  const progress = slidePoints && slidePoints.length > 0
    ? Math.min(1, (slidePoints[slidePoints.length - 1].x - BONE_START_X) / (BONE_END_X - BONE_START_X))
    : 0;

  return (
    <div
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border-2 border-amber-300"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={() => { if (isActive) onEnd(); }}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      <div className="absolute inset-0 opacity-30" style={{ backgroundImage: BOARD_BG }} />

      <svg {...SVG_PROPS}>
        {/* 開始ゾーンハイライト */}
        {!isActive && (
          <rect x={0} y={0} width={AREA_W * 0.4} height={AREA_H}
            fill="rgba(59,130,246,0.06)"
          />
        )}

        {/* 中骨ライン */}
        <path
          d={`M ${BONE_START_X} ${BONE_Y} Q ${AREA_W * 0.35} ${BONE_Y - 3} ${AREA_W / 2} ${BONE_Y} Q ${AREA_W * 0.65} ${BONE_Y + 3} ${BONE_END_X} ${BONE_Y}`}
          fill="none"
          stroke={isActive ? zoneColor : "#64748b"}
          strokeWidth={isActive ? 5 : 4}
          strokeDasharray={isActive ? "none" : "8,5"}
          strokeLinecap="round"
        />
        {/* 骨模様 */}
        {Array.from({ length: 8 }).map((_, i) => {
          const x = BONE_START_X + (BONE_END_X - BONE_START_X) * ((i + 1) / 9);
          return (
            <line key={i} x1={x} y1={BONE_Y - 10} x2={x} y2={BONE_Y + 10}
              stroke="rgba(100,116,139,0.3)" strokeWidth={1.5} />
          );
        })}

        {/* 始点マーカー */}
        <circle cx={BONE_START_X} cy={BONE_Y} r={14}
          fill={isActive ? zoneColor : "#dbeafe"} stroke={isActive ? zoneColor : "#3b82f6"}
          strokeWidth={2.5} className={isActive ? "" : "animate-pulse"}
        />
        <text x={BONE_START_X} y={BONE_Y + 4} textAnchor="middle" fontSize={9} fontWeight="bold"
          fill={isActive ? "#fff" : "#1e40af"}>始</text>

        {/* 終点マーカー */}
        <circle cx={BONE_END_X} cy={BONE_Y} r={10}
          fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="3,3" />
        <text x={BONE_END_X} y={BONE_Y + 3.5} textAnchor="middle" fontSize={8} fill="#64748b">終</text>

        {/* 軌跡 */}
        {slidePoints && slidePoints.length > 1 && (
          <polyline
            points={slidePoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke="rgba(220,50,50,0.7)" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}
      </svg>

      {/* 速度インジケーター */}
      {isActive && zoneLabel && (
        <div className="absolute top-2 right-2">
          <div className={`text-xs font-bold px-2 py-1 rounded-full ${
            speedZone === "fast" ? "bg-red-500 text-white animate-pulse" : "bg-green-500 text-white"
          }`}>
            {zoneLabel}
          </div>
        </div>
      )}

      {/* 進捗バー */}
      {isActive && (
        <div className="absolute top-2 left-2 w-20 h-2.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? "bg-orange-500 text-white" : "bg-blue-500 text-white animate-pulse"
        }`}>
          {isActive ? "骨に沿ってゆっくり右へ..." : "🦴 左側からゆっくり右へスワイプ"}
        </span>
      </div>
    </div>
  );
}

// ── 3. 腹骨すく ──
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
      className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border-2 border-amber-300"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseMove={onMove}
      onMouseUp={onEnd}
      onMouseLeave={() => { if (isActive) onEnd(); }}
      onTouchStart={onStart}
      onTouchMove={onMove}
      onTouchEnd={onEnd}
    >
      <div className="absolute inset-0 opacity-30" style={{ backgroundImage: BOARD_BG }} />

      <svg {...SVG_PROPS}>
        {/* 腹骨弧ガイドライン */}
        <polyline
          points={arc.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={isActive ? "#f59e0b" : "#3b82f6"}
          strokeWidth={isActive ? 4.5 : 4}
          strokeDasharray={isActive ? "none" : "6,4"}
          strokeLinecap="round"
        />

        {/* 始点マーカー（大きめ） */}
        <circle cx={arc[0].x} cy={arc[0].y} r={16}
          fill={isActive ? "rgba(245,158,11,0.3)" : "rgba(59,130,246,0.15)"}
          stroke={isActive ? "#f59e0b" : "#3b82f6"}
          strokeWidth={2.5} className={isActive ? "" : "animate-pulse"}
        />
        <text x={arc[0].x} y={arc[0].y + 4} textAnchor="middle" fontSize={9} fontWeight="bold"
          fill={isActive ? "#92400e" : "#1e40af"}>始</text>

        {/* 終点マーカー */}
        <circle cx={arc[arc.length - 1].x} cy={arc[arc.length - 1].y} r={12}
          fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="3,3" />
        <text x={arc[arc.length - 1].x} y={arc[arc.length - 1].y + 3.5}
          textAnchor="middle" fontSize={8} fill="#64748b">終</text>

        {/* 軌跡 */}
        {bellyPoints && bellyPoints.length > 1 && (
          <polyline
            points={bellyPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke="rgba(245,158,11,0.7)" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* 魚体輪郭 */}
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 - 8} rx={90} ry={35}
          fill="none" stroke="rgba(100,116,139,0.12)" strokeWidth={1.5} />
      </svg>

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? "bg-amber-500 text-white" : "bg-blue-500 text-white animate-pulse"
        }`}>
          {isActive ? "弧に沿って丁寧に..." : "🔻 始点から弧に沿ってスワイプ"}
        </span>
      </div>
    </div>
  );
}

// ── 4. シャリを取る ──
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
  const idealMin = idealRatio - 0.10;
  const idealMax = idealRatio + 0.10;
  const inIdealZone = riceRatio >= idealMin && riceRatio <= idealMax;
  const riceSize = 20 + riceRatio * 50;

  return (
    <div
      className="relative bg-gradient-to-b from-yellow-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border-2 border-green-300 cursor-pointer"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseUp={onEnd}
      onTouchStart={(e) => { e.preventDefault(); onStart(e); }}
      onTouchEnd={onEnd}
    >
      <svg {...SVG_PROPS}>
        {/* シャリ桶 */}
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 + 22} rx={65} ry={28}
          fill="#fef3c7" stroke="#d97706" strokeWidth={2} />
        <ellipse cx={AREA_W / 2} cy={AREA_H / 2 + 10} rx={65} ry={28}
          fill="#fffbeb" stroke="#d97706" strokeWidth={2} />
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i / 12) * Math.PI * 2;
          return (
            <circle key={i}
              cx={AREA_W / 2 + Math.cos(angle) * 40}
              cy={AREA_H / 2 + 10 + Math.sin(angle) * 16}
              r={2} fill="rgba(217,119,6,0.25)" />
          );
        })}

        {/* 成長するシャリ玉 */}
        {isActive && (
          <ellipse
            cx={AREA_W / 2} cy={AREA_H / 2 - 22}
            rx={riceSize * 0.7} ry={riceSize * 0.4}
            fill={inIdealZone ? "#86efac" : "#fffbeb"}
            stroke={inIdealZone ? "#16a34a" : "#d97706"}
            strokeWidth={2.5}
          />
        )}

        {/* サイズゲージ */}
        <rect x={AREA_W - 28} y={12} width={12} height={AREA_H - 24}
          fill="#e5e7eb" rx={6} />
        <rect
          x={AREA_W - 28}
          y={12 + (AREA_H - 24) * (1 - idealMax)}
          width={12}
          height={(AREA_H - 24) * (idealMax - idealMin)}
          fill="#86efac" rx={3} />
        {isActive && (
          <circle
            cx={AREA_W - 22}
            cy={12 + (AREA_H - 24) * (1 - riceRatio)}
            r={6}
            fill={inIdealZone ? "#16a34a" : "#d97706"}
            stroke="#fff" strokeWidth={2} />
        )}
        <text x={AREA_W - 22} y={10} textAnchor="middle" fontSize={7} fill="#6b7280">大</text>
        <text x={AREA_W - 22} y={AREA_H - 2} textAnchor="middle" fontSize={7} fill="#6b7280">小</text>
      </svg>

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? (inIdealZone ? "bg-green-500 text-white animate-pulse" : "bg-amber-500 text-white") : "bg-green-500 text-white animate-pulse"
        }`}>
          {isActive
            ? (inIdealZone ? "今だ！指を離してシャリを取る！" : `シャリを握り中... ${Math.round(riceRatio * 100)}%`)
            : `🍚 どこでも長押し → 緑ゾーンで離す（${stage.size === "small" ? "小さめ" : stage.size === "large" ? "大きめ" : "中くらい"}）`
          }
        </span>
      </div>
    </div>
  );
}

// ── 5. ピンチ ──
interface NigiriPinchAreaProps {
  isActive: boolean;
  pinchSamples?: number[];
  pinchStartDist?: number;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onClick: () => void;
}

function NigiriPinchArea({ isActive, pinchSamples, pinchStartDist, onTouchStart, onTouchMove, onTouchEnd, onClick }: NigiriPinchAreaProps) {
  const progress = isActive && pinchSamples && pinchStartDist && pinchSamples.length > 0
    ? Math.max(0, Math.min(1, 1 - pinchSamples[pinchSamples.length - 1] / pinchStartDist))
    : 0;
  const gap = 30 * (1 - progress);

  return (
    <div
      className="relative bg-gradient-to-b from-orange-50 to-amber-100 rounded-lg overflow-hidden select-none border-2 border-green-300 cursor-pointer"
      style={{ height: AREA_H, touchAction: "none" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onClick={onClick}
    >
      <svg {...SVG_PROPS}>
        {/* ネタ（上） */}
        <ellipse
          cx={AREA_W / 2} cy={AREA_H / 2 - gap / 2 - 12}
          rx={50} ry={16}
          fill="#fb923c" stroke="#ea580c" strokeWidth={1.5} />
        <text x={AREA_W / 2} y={AREA_H / 2 - gap / 2 - 10}
          textAnchor="middle" fontSize={9} fill="#7c2d12" fontWeight="bold">ネタ</text>

        {/* シャリ（下） */}
        <ellipse
          cx={AREA_W / 2} cy={AREA_H / 2 + gap / 2 + 12}
          rx={45} ry={18}
          fill="#fffbeb" stroke="#d97706" strokeWidth={1.5} />
        <text x={AREA_W / 2} y={AREA_H / 2 + gap / 2 + 14}
          textAnchor="middle" fontSize={9} fill="#92400e" fontWeight="bold">シャリ</text>

        {/* ピンチ矢印 */}
        {!isActive && (
          <>
            <text x={AREA_W / 2 - 60} y={AREA_H / 2 + 7} fontSize={22}>👆</text>
            <line x1={AREA_W / 2 - 42} y1={AREA_H / 2}
                  x2={AREA_W / 2 - 12} y2={AREA_H / 2}
                  stroke="#3b82f6" strokeWidth={2.5} />
            <polygon points={`${AREA_W / 2 - 15},${AREA_H / 2 - 4} ${AREA_W / 2 - 8},${AREA_H / 2} ${AREA_W / 2 - 15},${AREA_H / 2 + 4}`}
              fill="#3b82f6" />
            <text x={AREA_W / 2 + 42} y={AREA_H / 2 + 7} fontSize={22}>👆</text>
            <line x1={AREA_W / 2 + 42} y1={AREA_H / 2}
                  x2={AREA_W / 2 + 12} y2={AREA_H / 2}
                  stroke="#3b82f6" strokeWidth={2.5} />
            <polygon points={`${AREA_W / 2 + 15},${AREA_H / 2 - 4} ${AREA_W / 2 + 8},${AREA_H / 2} ${AREA_W / 2 + 15},${AREA_H / 2 + 4}`}
              fill="#3b82f6" />
          </>
        )}

        {/* 進捗リング */}
        {isActive && (
          <circle
            cx={AREA_W / 2} cy={AREA_H / 2}
            r={38} fill="none"
            stroke="#22c55e" strokeWidth={3.5}
            strokeDasharray={`${progress * Math.PI * 76} ${Math.PI * 76}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${AREA_W / 2} ${AREA_H / 2})`} />
        )}
      </svg>

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? "bg-green-500 text-white" : "bg-green-500 text-white animate-pulse"
        }`}>
          {isActive
            ? `合わせ中... ${Math.round(progress * 100)}%`
            : "🤏 二本指ピンチで合わせる（PCはクリック）"
          }
        </span>
      </div>
    </div>
  );
}

// ── 6. 本手返し ──
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

  const squish = 1 + pressRatio * 0.3;
  const squishY = 1 - pressRatio * 0.15;

  return (
    <div
      className="relative bg-gradient-to-b from-yellow-50 to-orange-100 rounded-lg overflow-hidden select-none touch-none border-2 border-green-300 cursor-pointer"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseUp={onEnd}
      onTouchStart={(e) => { e.preventDefault(); onStart(e); }}
      onTouchEnd={onEnd}
    >
      <svg {...SVG_PROPS}>
        {/* 圧力ゲージ */}
        <rect x={15} y={12} width={16} height={AREA_H - 24}
          fill="#e5e7eb" rx={8} />
        <rect
          x={15}
          y={12 + (AREA_H - 24) * (1 - hi)}
          width={16}
          height={(AREA_H - 24) * (hi - lo)}
          fill="rgba(34,197,94,0.5)" rx={4} />
        <rect
          x={15}
          y={12 + (AREA_H - 24) * (1 - pressRatio)}
          width={16}
          height={Math.max(3, (AREA_H - 24) * pressRatio)}
          fill={inSweet ? "#22c55e" : pressRatio > hi ? "#ef4444" : "#fbbf24"}
          rx={4} />
        <text x={23} y={10} textAnchor="middle" fontSize={7} fill="#6b7280">強</text>
        <text x={23} y={AREA_H - 2} textAnchor="middle" fontSize={7} fill="#6b7280">弱</text>

        {/* 寿司 */}
        <g transform={`translate(${AREA_W / 2 + 10}, ${AREA_H / 2 + 5})`}>
          <ellipse cx={0} cy={8} rx={38 * squish} ry={20 * squishY}
            fill="#fffbeb" stroke="#d97706" strokeWidth={1.5} />
          <ellipse cx={0} cy={-5} rx={42 * squish} ry={14 * squishY}
            fill="#fb923c" stroke="#ea580c" strokeWidth={1.5} />
          <ellipse cx={-10} cy={-8} rx={14} ry={5}
            fill="rgba(255,255,255,0.3)" />
        </g>

        {/* 状態テキスト */}
        {isActive && (
          <text
            x={AREA_W / 2 + 10} y={22}
            textAnchor="middle" fontSize={14} fontWeight="bold"
            fill={inSweet ? "#16a34a" : pressRatio > hi ? "#dc2626" : "#d97706"}
          >
            {inSweet ? "今だ！離す！" : tooSoft ? "もう少し..." : "強すぎ！"}
          </text>
        )}

        {!isActive && (
          <text x={AREA_W / 2 + 10} y={AREA_H / 2 + 8} textAnchor="middle" fontSize={28}>🤲</text>
        )}
      </svg>

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? (inSweet ? "bg-green-500 text-white animate-pulse" : "bg-amber-500 text-white") : "bg-green-500 text-white animate-pulse"
        }`}>
          {isActive
            ? `圧 ${Math.round(pressRatio * 100)}% — ${inSweet ? "完璧！指を離せ！" : tooSoft ? "もっと押し続ける..." : "強すぎる！早く離せ！"}`
            : "🤲 長押しして握る → 緑のゾーンで離す"
          }
        </span>
      </div>
    </div>
  );
}
