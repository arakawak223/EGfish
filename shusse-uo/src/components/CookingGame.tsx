"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CaughtFish, calculateFreshness } from "@/lib/game-state";
import { FISH_DATABASE, FishSpecies } from "@/lib/fish-data";
import { vibrate, HAPTIC_PATTERNS } from "@/lib/haptics";
import {
  playSESlice, playSESell, playSEMiss, playSEPrepDone,
  playSEBoneResist, playSENigiriPerfect, playSENigiriFail, playSECatch,
} from "@/lib/audio";

interface CookingGameProps {
  inventory: CaughtFish[];
  marketTrend: Partial<Record<FishSpecies, number>>;
  onSell: (fishId: string, price: number) => void;
  timeMultiplier?: number;
  paused?: boolean;
}

// 2ステップ調理ステート
type PrepState = "idle" | "slice" | "press" | "done";

interface PrepProgress {
  fishId: string;
  state: PrepState;
  sliceScore: number;
  pressScore: number;
  avgAccuracy: number;
  perfect: boolean;
  ultimate: boolean;
}

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

// ── 三枚おろし（一本スワイプ） ──
const SLICE_Y = AREA_H / 2;
const SLICE_START_X = 30;
const SLICE_END_X = AREA_W - 30;
const SLICE_COMPLETE_X = AREA_W - 45;    // このX以上まで届けば完了扱い
const BONE_POINTS_RATIO = [0.22, 0.38, 0.54, 0.70, 0.86]; // 骨の位置（スライス線上）
const BONE_HIT_RADIUS = 16;               // 骨通過判定の半径

// ── 握り（長押し → 光る瞬間で離す） ──
const PRESS_MAX_MS = 2200;
const PRESS_SWEET_CENTER = 0.55;
const PRESS_SWEET_HALF_NORMAL = 0.10;   // 幅 0.20
const PRESS_SWEET_HALF_SHINKO = 0.035;  // 幅 0.07（シビア）

// シンコ判定
function isShinko(fish: CaughtFish): boolean {
  return fish.stageName === "シンコ";
}

// シンコは狭くて短い帯域、かつズレ許容も極小
function getSliceBand(fish: CaughtFish): number {
  return isShinko(fish) ? 10 : 28;
}
function getSliceRange(fish: CaughtFish): { start: number; end: number; completeAt: number } {
  if (isShinko(fish)) {
    return {
      start: AREA_W * 0.32,
      end: AREA_W * 0.68,
      completeAt: AREA_W * 0.64,
    };
  }
  return { start: SLICE_START_X, end: SLICE_END_X, completeAt: SLICE_COMPLETE_X };
}
function getPressSweet(fish: CaughtFish): { lo: number; hi: number } {
  const half = isShinko(fish) ? PRESS_SWEET_HALF_SHINKO : PRESS_SWEET_HALF_NORMAL;
  return { lo: PRESS_SWEET_CENTER - half, hi: PRESS_SWEET_CENTER + half };
}

// ── チュートリアルガイド（2ステップ） ──
function TutorialGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-blue-800">調理ガイド — たった2アクション</span>
        <button
          onClick={onClose}
          className="text-xs bg-blue-500 text-white px-3 py-1 rounded-full font-bold active:scale-95"
        >
          閉じる
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="bg-white rounded-lg p-3 border border-orange-200">
          <div className="text-2xl mb-1 text-center">🔪</div>
          <div className="text-xs font-bold text-orange-700 text-center mb-1">① 三枚おろし</div>
          <div className="text-[10px] text-gray-600 leading-tight text-center">
            魚の中央を一本のスワイプで切り裂く<br/>
            （骨の手応えを感じたら正解ルート）
          </div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-green-200">
          <div className="text-2xl mb-1 text-center">🤲</div>
          <div className="text-xs font-bold text-green-700 text-center mb-1">② 握り</div>
          <div className="text-[10px] text-gray-600 leading-tight text-center">
            長押しで圧力を溜め、<br/>
            光った瞬間に指を離す
          </div>
        </div>
      </div>

      <div className="text-center">
        <div className="text-[10px] text-blue-600 bg-blue-100 rounded-full px-3 py-1 inline-block">
          シンコは許容範囲が極小。完璧に決めると『究極の一皿』！
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
  const [ultimateEffect, setUltimateEffect] = useState<{ fishId: string; name: string } | null>(null);
  const [, setTick] = useState(0);
  const forceTick = useCallback(() => setTick((t) => (t + 1) & 0xffff), []);

  const activePhaseRef = useRef<{
    fishId: string;
    phase: PrepState;
    startTime: number;
    // slice
    slicePoints?: { x: number; y: number }[];
    sliceMaxX?: number;
    sliceDeviationSum?: number;
    sliceDeviationCount?: number;
    sliceBoneHit?: boolean[];
    // press
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

  // 握りゲージの進行
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const loop = () => {
      const active = activePhaseRef.current;
      if (active && active.phase === "press") {
        const elapsed = performance.now() - active.startTime;
        active.pressRatio = Math.min(1, elapsed / (PRESS_MAX_MS * timeMultiplier));
        forceTick();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused, timeMultiplier, forceTick]);

  // 究極の一皿エフェクト自動消去
  useEffect(() => {
    if (!ultimateEffect) return;
    const timer = setTimeout(() => setUltimateEffect(null), 2600);
    return () => clearTimeout(timer);
  }, [ultimateEffect]);

  function makeInitialPrep(fishId: string): PrepProgress {
    return {
      fishId, state: "idle",
      sliceScore: 0, pressScore: 0,
      avgAccuracy: 0, perfect: false, ultimate: false,
    };
  }

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

  const toRelative = (clientX: number, clientY: number) => {
    const rect = activeRectRef.current;
    if (!rect) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * AREA_W,
      y: ((clientY - rect.top) / rect.height) * AREA_H,
    };
  };

  // ── ① 三枚おろし ──

  const startSlice = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    const range = getSliceRange(fish);
    // 開始は線の始点付近（左端寄り）から
    if (pos.x > range.start + (range.end - range.start) * 0.35) return;

    activePhaseRef.current = {
      fishId: fish.id,
      phase: "slice",
      startTime: performance.now(),
      slicePoints: [pos],
      sliceMaxX: pos.x,
      sliceDeviationSum: Math.abs(pos.y - SLICE_Y),
      sliceDeviationCount: 1,
      sliceBoneHit: BONE_POINTS_RATIO.map(() => false),
    };
    vibrate([5]);
    forceTick();
  }, [forceTick]);

  const finishSlice = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "slice" || active.fishId !== fish.id) return;

    const range = getSliceRange(fish);
    const band = getSliceBand(fish);
    const coverage = Math.max(0, Math.min(1,
      ((active.sliceMaxX ?? 0) - range.start) / (range.end - range.start)
    ));
    const avgDev = (active.sliceDeviationSum ?? 0) / Math.max(1, active.sliceDeviationCount ?? 1);
    const pathAcc = Math.max(0, Math.min(1, 1 - avgDev / band));
    const boneHits = (active.sliceBoneHit ?? []).filter(Boolean).length;
    const boneRatio = boneHits / BONE_POINTS_RATIO.length;

    // 終点まで届いたときはボーナス
    const completed = coverage >= 0.85 ? 1 : coverage / 0.85;
    const sliceScore = Math.max(0, Math.min(1,
      pathAcc * 0.45 + boneRatio * 0.30 + completed * 0.25
    ));

    // 終点での大きなフィードバック
    if (completed >= 0.9) {
      playSESlice();
      vibrate([25, 8, 35, 10, 60]);
    } else {
      playSEBoneResist();
      vibrate([15, 10, 30]);
    }

    activePhaseRef.current = null;
    setPrepProgress((prev) => {
      const p = prev[fish.id] ?? makeInitialPrep(fish.id);
      return { ...prev, [fish.id]: { ...p, state: "press", sliceScore } };
    });
    forceTick();
  }, [forceTick]);

  const handleSliceMove = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "slice" || active.fishId !== fish.id) return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    const range = getSliceRange(fish);
    active.slicePoints!.push(pos);
    active.sliceDeviationSum! += Math.abs(pos.y - SLICE_Y);
    active.sliceDeviationCount! += 1;
    if (pos.x > (active.sliceMaxX ?? 0)) active.sliceMaxX = pos.x;

    // 骨通過チェック（未通過の骨を順にテスト）
    for (let i = 0; i < BONE_POINTS_RATIO.length; i++) {
      if (active.sliceBoneHit![i]) continue;
      const bx = range.start + (range.end - range.start) * BONE_POINTS_RATIO[i];
      const dist = Math.hypot(pos.x - bx, pos.y - SLICE_Y);
      if (dist < BONE_HIT_RADIUS) {
        active.sliceBoneHit![i] = true;
        vibrate([6]); // 微細振動
      }
    }

    // 完了判定: 終点付近まで届いた
    if (pos.x >= range.completeAt) {
      finishSlice(fish);
      return;
    }
    forceTick();
  }, [forceTick, finishSlice]);

  const handleSliceEnd = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "slice" || active.fishId !== fish.id) return;
    // 途中で指を離した場合もスコア付けして次段へ
    finishSlice(fish);
  }, [finishSlice]);

  // ── ② 握り（長押し → 離す） ──

  const startPress = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    if (activePhaseRef.current) return;
    e.preventDefault();
    activePhaseRef.current = {
      fishId: fish.id,
      phase: "press",
      startTime: performance.now(),
      pressRatio: 0,
    };
    vibrate([6]);
    forceTick();
  }, [forceTick]);

  const finishPress = useCallback((fish: CaughtFish) => {
    const active = activePhaseRef.current;
    if (!active || active.phase !== "press" || active.fishId !== fish.id) return;
    const ratio = active.pressRatio ?? 0;
    activePhaseRef.current = null;

    const sweet = getPressSweet(fish);
    let pressScore: number;
    if (ratio >= sweet.lo && ratio <= sweet.hi) {
      const center = (sweet.lo + sweet.hi) / 2;
      const half = (sweet.hi - sweet.lo) / 2;
      pressScore = 1 - Math.abs(ratio - center) / half * 0.15;
    } else {
      const dist = ratio < sweet.lo ? sweet.lo - ratio : ratio - sweet.hi;
      pressScore = Math.max(0, 1 - dist / 0.18);
    }
    pressScore = Math.max(0, Math.min(1, pressScore));

    if (pressScore >= 0.85) {
      vibrate(HAPTIC_PATTERNS.pressPerfect);
      playSENigiriPerfect();
    } else if (ratio < sweet.lo) {
      vibrate(HAPTIC_PATTERNS.pressSoft);
      playSENigiriFail();
    } else {
      vibrate(HAPTIC_PATTERNS.pressHard);
      playSENigiriFail();
    }
    playSEPrepDone();

    setPrepProgress((prev) => {
      const p = prev[fish.id] ?? makeInitialPrep(fish.id);
      const finalAcc = Math.min(1, p.sliceScore * 0.5 + pressScore * 0.5);
      const perfect = finalAcc >= 0.85;
      const ultimate = isShinko(fish) && p.sliceScore >= 0.80 && pressScore >= 0.85;
      if (ultimate) {
        // 究極の一皿エフェクト発動
        playSECatch();
        vibrate([30, 20, 80, 20, 150, 30, 80]);
        setUltimateEffect({ fishId: fish.id, name: fish.stageName });
      }
      return {
        ...prev,
        [fish.id]: {
          ...p,
          state: "done",
          pressScore,
          avgAccuracy: finalAcc,
          perfect,
          ultimate,
        },
      };
    });
    forceTick();
  }, [forceTick]);

  // ── 販売 ──

  const handleInstantSell = (fish: CaughtFish) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;
    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const prep = prepProgress[fish.id];
    const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1;
    const ultimateMult = prep?.ultimate ? 1.8 : 1;
    const price = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult * ultimateMult);
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
    const ultimateMult = prep?.ultimate ? 2.2 : 1;
    const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMult * ultimateMult);

    const rarityBonus = fish.sushiPrice > 2000 ? 0.6 : fish.sushiPrice > 800 ? 0.8 : 1.0;
    const waitTime = COUNTER_BASE_WAIT + Math.random() * (COUNTER_MAX_WAIT - COUNTER_BASE_WAIT) * rarityBonus;

    setCounter((prev) => [
      ...prev,
      { fishId: fish.id, price: premiumPrice, placedAt: Date.now(), waitTime, customerArrived: false, expired: false },
    ]);
  };

  const activeCounterCount = counter.filter((c) => !c.customerArrived && !c.expired).length;
  const counterFull = activeCounterCount >= MAX_COUNTER_SLOTS;

  const accuracyLabel = (acc: number, ultimate: boolean) => {
    if (ultimate) return { text: "究極", color: "text-fuchsia-500", icon: "★" };
    if (acc >= 0.85) return { text: "極上", color: "text-yellow-500", icon: "✨" };
    if (acc >= 0.6) return { text: "上物", color: "text-green-500", icon: "○" };
    if (acc >= 0.35) return { text: "並", color: "text-gray-500", icon: "△" };
    return { text: "雑", color: "text-red-400", icon: "✕" };
  };

  const stepLabels = ["三枚おろし", "握り"];
  const stepOrder: PrepState[] = ["slice", "press"];

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
    <div className="relative h-full bg-gradient-to-b from-amber-50 to-orange-100 overflow-y-auto p-3">
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
          const fishFreshness = freshness[fish.id] ?? 100;
          const prep = prepProgress[fish.id];
          const currentState: PrepState = prep?.state ?? "idle";
          const isDone = currentState === "done";
          const isRotten = fishFreshness <= 0;
          const isRare = fishData.reverseValue && fish.stageIndex === 0;
          const shinko = isShinko(fish);

          const trendMult = marketTrend[fish.species] ?? 1;
          const freshMult = fishFreshness / 100;
          const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1;
          const qualityMultPremium = prep ? 0.8 + prep.avgAccuracy * 0.7 : 1;
          const ultimateMult = prep?.ultimate ? 1.8 : 1;
          const ultimateMultPremium = prep?.ultimate ? 2.2 : 1;
          const instantPrice = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult * ultimateMult);
          const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMultPremium * ultimateMultPremium);

          const active = activePhaseRef.current;
          const isActiveForThis = active?.fishId === fish.id;

          return (
            <div
              key={fish.id}
              className={`bg-white rounded-xl shadow-md p-4 ${
                isRotten ? "opacity-50" : ""
              } ${isRare ? "ring-2 ring-yellow-400" : ""} ${prep?.ultimate ? "ring-4 ring-fuchsia-400" : ""}`}
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
                  {shinko && (
                    <span className="ml-1 text-xs bg-fuchsia-500 text-white px-1.5 py-0.5 rounded-full font-bold animate-pulse">
                      極小＝極難
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <span className="text-green-600 font-bold">¥{fish.sushiPrice.toLocaleString()}</span>
                  {isDone && prep && (
                    <span className={`block text-xs font-bold ${accuracyLabel(prep.avgAccuracy, prep.ultimate).color}`}>
                      {accuracyLabel(prep.avgAccuracy, prep.ultimate).icon} {accuracyLabel(prep.avgAccuracy, prep.ultimate).text}
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

              {/* ステップインジケーター（2段） */}
              {!isRotten && !isDone && (
                <div className="flex items-center gap-2 mb-2 justify-center">
                  {stepOrder.map((step, i) => {
                    const currentIdx = stepOrder.indexOf(currentState === "idle" ? "slice" : currentState);
                    const done = i < currentIdx;
                    const isCurrent = step === (currentState === "idle" ? "slice" : currentState);
                    return (
                      <div key={step} className="flex items-center">
                        <div className={`px-2.5 h-7 rounded-full flex items-center gap-1 text-[10px] font-bold border-2 ${
                          done ? "bg-green-500 border-green-500 text-white" :
                          isCurrent ? "bg-blue-500 border-blue-500 text-white animate-pulse" :
                          "bg-gray-100 border-gray-300 text-gray-400"
                        }`}>
                          <span>{i + 1}</span>
                          <span>{stepLabels[i]}</span>
                          {done && <span>✓</span>}
                        </div>
                        {i < 1 && <div className={`w-3 h-0.5 ${done ? "bg-green-400" : "bg-gray-200"}`} />}
                      </div>
                    );
                  })}
                </div>
              )}

              {isRotten ? (
                <div className="text-center text-gray-400 text-sm py-2">鮮度が落ちてしまいました...</div>
              ) : (currentState === "idle" || currentState === "slice") ? (
                <SliceArea
                  fish={fish}
                  isActive={isActiveForThis && active?.phase === "slice"}
                  slicePoints={isActiveForThis ? active?.slicePoints : undefined}
                  boneHit={isActiveForThis ? active?.sliceBoneHit : undefined}
                  onStart={(e) => startSlice(fish, e)}
                  onMove={(e) => handleSliceMove(fish, e)}
                  onEnd={() => handleSliceEnd(fish)}
                />
              ) : currentState === "press" ? (
                <PressArea
                  fish={fish}
                  pressRatio={isActiveForThis ? active?.pressRatio ?? 0 : 0}
                  isActive={isActiveForThis && active?.phase === "press"}
                  onStart={(e) => startPress(fish, e)}
                  onEnd={() => finishPress(fish)}
                />
              ) : isDone ? (
                <div className="space-y-2">
                  {prep?.ultimate && (
                    <div className="text-center bg-gradient-to-r from-fuchsia-500 via-pink-500 to-amber-400 text-white font-bold py-1.5 rounded-lg text-sm">
                      ★ 究極の一皿 ★
                    </div>
                  )}
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

      {/* 究極の一皿エフェクト */}
      {ultimateEffect && <UltimateOverlay name={ultimateEffect.name} />}
    </div>
  );
}

// ════════════════════════════════════════════
// サブコンポーネント
// ════════════════════════════════════════════

const SVG_PROPS = {
  className: "absolute inset-0 w-full h-full pointer-events-none",
  viewBox: `0 0 ${AREA_W} ${AREA_H}`,
  preserveAspectRatio: "none",
} as const;

const BOARD_BG = "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)";

// ── ① 三枚おろし ──
interface SliceAreaProps {
  fish: CaughtFish;
  isActive: boolean;
  slicePoints?: { x: number; y: number }[];
  boneHit?: boolean[];
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onMove: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function SliceArea({ fish, isActive, slicePoints, boneHit, onStart, onMove, onEnd }: SliceAreaProps) {
  const shinko = isShinko(fish);
  const range = getSliceRange(fish);
  const band = getSliceBand(fish);
  const progress = slicePoints && slicePoints.length > 0
    ? Math.max(0, Math.min(1,
        (slicePoints[slicePoints.length - 1].x - range.start) / (range.end - range.start)
      ))
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
        {/* 魚シルエット（スライス線の全長に合わせて変形） */}
        <ellipse
          cx={(range.start + range.end) / 2}
          cy={SLICE_Y}
          rx={(range.end - range.start) / 2 + 14}
          ry={shinko ? 14 : 34}
          fill="rgba(156,163,175,0.18)"
          stroke="rgba(107,114,128,0.35)" strokeWidth={1.2}
        />
        {/* 魚目 */}
        <circle
          cx={range.start + 6} cy={SLICE_Y - (shinko ? 4 : 8)}
          r={shinko ? 2 : 3}
          fill="#1f2937"
        />

        {/* 許容帯 */}
        <rect
          x={range.start} y={SLICE_Y - band}
          width={range.end - range.start} height={band * 2}
          fill={isActive ? "rgba(34,197,94,0.10)" : "rgba(59,130,246,0.08)"}
        />

        {/* ガイド線 */}
        <line
          x1={range.start} y1={SLICE_Y} x2={range.end} y2={SLICE_Y}
          stroke={isActive ? "#22c55e" : "#64748b"}
          strokeWidth={isActive ? 3.5 : 2.5}
          strokeDasharray={isActive ? "none" : "8,5"}
          strokeLinecap="round"
        />

        {/* 骨マーカー */}
        {BONE_POINTS_RATIO.map((r, i) => {
          const bx = range.start + (range.end - range.start) * r;
          const hit = boneHit?.[i] ?? false;
          return (
            <g key={`bone-${i}`}>
              <line x1={bx} y1={SLICE_Y - 9} x2={bx} y2={SLICE_Y + 9}
                stroke={hit ? "#22c55e" : "rgba(100,116,139,0.55)"}
                strokeWidth={hit ? 3 : 2} strokeLinecap="round" />
              {hit && (
                <circle cx={bx} cy={SLICE_Y} r={5}
                  fill="rgba(34,197,94,0.25)" stroke="#22c55e" strokeWidth={1.5} />
              )}
            </g>
          );
        })}

        {/* 始点 */}
        <circle cx={range.start} cy={SLICE_Y} r={12}
          fill={isActive ? "rgba(239,68,68,0.25)" : "#dbeafe"}
          stroke={isActive ? "#ef4444" : "#3b82f6"} strokeWidth={2.5}
          className={isActive ? "" : "animate-pulse"} />
        <text x={range.start} y={SLICE_Y + 3.5} textAnchor="middle"
          fontSize={8} fontWeight="bold"
          fill={isActive ? "#fff" : "#1e40af"}>開始</text>

        {/* 終点 */}
        <circle cx={range.end} cy={SLICE_Y} r={9}
          fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="3,3" />
        <text x={range.end} y={SLICE_Y + 3} textAnchor="middle" fontSize={7} fill="#64748b">終</text>

        {/* 軌跡 */}
        {slicePoints && slicePoints.length > 1 && (
          <polyline
            points={slicePoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="rgba(220,50,50,0.8)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>

      {/* 進捗バー */}
      {isActive && (
        <div className="absolute top-2 left-2 w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {shinko && (
        <div className="absolute top-2 right-2 text-[10px] font-bold text-fuchsia-600 bg-white/80 px-2 py-0.5 rounded-full">
          シンコ：超狭レーン
        </div>
      )}

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? "bg-orange-500 text-white" : "bg-blue-500 text-white animate-pulse"
        }`}>
          {isActive
            ? "中央を一息に切り裂く...骨を感じながら"
            : "🔪 左端からスワイプで一気に中央を切り裂く"
          }
        </span>
      </div>
    </div>
  );
}

// ── ② 握り（長押し → 光る瞬間で離す） ──
interface PressAreaProps {
  fish: CaughtFish;
  pressRatio: number;
  isActive: boolean;
  onStart: (e: React.MouseEvent | React.TouchEvent) => void;
  onEnd: () => void;
}

function PressArea({ fish, pressRatio, isActive, onStart, onEnd }: PressAreaProps) {
  const shinko = isShinko(fish);
  const sweet = getPressSweet(fish);
  const inSweet = pressRatio >= sweet.lo && pressRatio <= sweet.hi;
  const tooSoft = pressRatio < sweet.lo;

  const squish = 1 + pressRatio * 0.3;
  const squishY = 1 - pressRatio * 0.15;

  return (
    <div
      className="relative bg-gradient-to-b from-yellow-50 to-orange-100 rounded-lg overflow-hidden select-none touch-none border-2 border-green-300 cursor-pointer"
      style={{ height: AREA_H }}
      onMouseDown={onStart}
      onMouseUp={onEnd}
      onMouseLeave={() => { if (isActive) onEnd(); }}
      onTouchStart={(e) => { e.preventDefault(); onStart(e); }}
      onTouchEnd={onEnd}
    >
      {/* 光るエフェクト：sweet spot の瞬間だけ強くフラッシュ */}
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-100"
        style={{
          opacity: isActive && inSweet ? 1 : 0,
          background: "radial-gradient(circle at center, rgba(250,204,21,0.55) 0%, rgba(251,191,36,0.25) 40%, transparent 70%)",
        }}
      />
      {isActive && inSweet && (
        <div className="absolute inset-0 pointer-events-none animate-pulse"
          style={{ boxShadow: "inset 0 0 40px 10px rgba(253,224,71,0.7)" }} />
      )}

      <svg {...SVG_PROPS}>
        {/* 圧力ゲージ */}
        <rect x={15} y={12} width={16} height={AREA_H - 24}
          fill="#e5e7eb" rx={8} />
        {/* sweet spot 帯 */}
        <rect
          x={15}
          y={12 + (AREA_H - 24) * (1 - sweet.hi)}
          width={16}
          height={Math.max(3, (AREA_H - 24) * (sweet.hi - sweet.lo))}
          fill={isActive && inSweet ? "#facc15" : "rgba(34,197,94,0.55)"}
          stroke={isActive && inSweet ? "#f59e0b" : "none"}
          strokeWidth={isActive && inSweet ? 2 : 0}
          rx={4}
          className={isActive && inSweet ? "animate-pulse" : ""}
        />
        {/* 現在値 */}
        <rect
          x={15}
          y={12 + (AREA_H - 24) * (1 - pressRatio)}
          width={16}
          height={Math.max(3, (AREA_H - 24) * pressRatio)}
          fill={inSweet ? "#22c55e" : pressRatio > sweet.hi ? "#ef4444" : "#fbbf24"}
          rx={4}
        />
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
            fill={inSweet ? "#b45309" : pressRatio > sweet.hi ? "#dc2626" : "#d97706"}
          >
            {inSweet ? "✦ 今だ！離せ！ ✦" : tooSoft ? "もう少し..." : "強すぎ！"}
          </text>
        )}

        {!isActive && (
          <text x={AREA_W / 2 + 10} y={AREA_H / 2 + 8} textAnchor="middle" fontSize={28}>🤲</text>
        )}
      </svg>

      {shinko && (
        <div className="absolute top-2 right-2 text-[10px] font-bold text-fuchsia-600 bg-white/80 px-2 py-0.5 rounded-full">
          シンコ：窓極小
        </div>
      )}

      <div className="absolute bottom-2 left-0 right-0 text-center">
        <span className={`text-xs px-3 py-1 rounded-full font-bold ${
          isActive ? (inSweet ? "bg-amber-500 text-white animate-pulse" : "bg-orange-600 text-white") : "bg-green-500 text-white animate-pulse"
        }`}>
          {isActive
            ? `圧 ${Math.round(pressRatio * 100)}% — ${inSweet ? "光っている！今すぐ離せ！" : tooSoft ? "長押しで圧力を溜める..." : "ゲージ超過！急げ"}`
            : "🤲 どこでも長押しで圧力を溜める"
          }
        </span>
      </div>
    </div>
  );
}

// ── 究極の一皿エフェクト ──
function UltimateOverlay({ name }: { name: string }) {
  const sparkles = Array.from({ length: 24 }, (_, i) => i);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/30 via-pink-500/20 to-amber-300/30 animate-pulse" />
      {sparkles.map((i) => {
        const angle = (i / sparkles.length) * Math.PI * 2;
        const radius = 120 + (i % 4) * 30;
        const delay = (i % 6) * 0.05;
        return (
          <div
            key={i}
            className="absolute text-3xl animate-ping"
            style={{
              left: `calc(50% + ${Math.cos(angle) * radius}px)`,
              top: `calc(50% + ${Math.sin(angle) * radius}px)`,
              animationDelay: `${delay}s`,
              animationDuration: "1.6s",
            }}
          >
            ✨
          </div>
        );
      })}
      <div className="relative text-center animate-[ultimate_2.6s_ease-out_forwards]">
        <div className="text-[10px] tracking-[0.4em] text-white/90 font-bold mb-2 drop-shadow-lg">
          ULTIMATE DISH
        </div>
        <div
          className="text-4xl font-black text-transparent bg-clip-text drop-shadow-2xl"
          style={{
            backgroundImage: "linear-gradient(120deg, #fef3c7 0%, #fbbf24 35%, #ec4899 65%, #a855f7 100%)",
            WebkitTextStroke: "1.5px rgba(255,255,255,0.6)",
          }}
        >
          究極の一皿
        </div>
        <div className="text-sm text-white font-bold mt-2 bg-black/40 rounded-full px-4 py-1 inline-block backdrop-blur">
          {name} — 完璧な握り
        </div>
      </div>
      <style jsx>{`
        @keyframes ultimate {
          0% { transform: scale(0.6) rotate(-4deg); opacity: 0; }
          20% { transform: scale(1.15) rotate(2deg); opacity: 1; }
          40% { transform: scale(1) rotate(0deg); opacity: 1; }
          85% { transform: scale(1) rotate(0deg); opacity: 1; }
          100% { transform: scale(1.05) rotate(0deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
