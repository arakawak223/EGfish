"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CaughtFish, calculateFreshness } from "@/lib/game-state";
import { FISH_DATABASE, FishSpecies } from "@/lib/fish-data";
import { vibrate } from "@/lib/haptics";
import { playSESlice, playSESell, playSEMiss, playSEPrepDone } from "@/lib/audio";

interface CookingGameProps {
  inventory: CaughtFish[];
  marketTrend: Partial<Record<FishSpecies, number>>;
  onSell: (fishId: string, price: number) => void;
}

type PrepState = "idle" | "cutting" | "done";
// trace: 曲線をなぞる / connect: 順番にノードをつなぐ / timing: リズムに合わせてゲートを通す
type GuideType = "trace" | "connect" | "timing";

// 「つなぐ」用の通過ノード（関節）
interface Waypoint {
  x: number;
  y: number;
  order: number;
  hit: boolean;
}

// 「タイミング合わせ」用のゲート（曲線上に配置、openAt〜closeAtの間だけ通過可能）
interface TimingGate {
  x: number;
  y: number;
  openAt: number;  // 区間開始からのms
  closeAt: number;
  hit: boolean;
}

// ガイドパス: すべて曲線ベース。タイプごとに追加要素を持つ
interface GuidePath {
  type: GuideType;
  samples: { x: number; y: number }[]; // パスをサンプリングした点列
  svgPath: string; // SVG描画用 d属性
  waypoints?: Waypoint[]; // connect用
  gates?: TimingGate[];   // timing用
  visited?: boolean[]; // samples各点を通過したか（進行中のみ使う、完了時リセット）
  completed: boolean;
  accuracy: number;  // 0~1
  speedBonus: number; // 0~1, 速度ジャスト度
  modeScore: number;  // 0~1, connect/timingの達成率 (trace=1)
}

interface PrepProgress {
  fishId: string;
  guides: GuidePath[];
  currentGuide: number;
  state: PrepState;
  avgAccuracy: number;
  maxCombo: number; // 最大連続一筆コンボ
  perfect: boolean; // 全ガイド一筆貫通フラグ
}

// 進行中のカット状態（ref管理・handleCutMove中に変更するためstate化しない）
interface ActiveCutState {
  fishId: string;
  currentGuide: number;
  segmentStartIdx: number; // drawPoints内の現ガイド開始点
  segmentStartTime: number;
  comboCount: number;
  guidesSnapshot: GuidePath[]; // 生成されたガイド
  totalGuides: number;
  accumulatedAccuracy: number;
  accumulatedSpeedBonus: number;
  accumulatedModeScore: number;
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
const AREA_H = 140;
const MARGIN = 22;

// 線分をサンプリング
function sampleLine(x1: number, y1: number, x2: number, y2: number, steps = 16) {
  const arr: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    arr.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return arr;
}

// 3次ベジェをサンプリング
function sampleCubic(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  steps = 28
) {
  const arr: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x =
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const y =
      u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    arr.push({ x, y });
  }
  return arr;
}

// パスの全長
function pathLength(samples: { x: number; y: number }[]) {
  let len = 0;
  for (let i = 1; i < samples.length; i++) {
    len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  }
  return len;
}

// 魚ごとにガイドを生成:
//   すべての筋は曲線（S字/弧）ベース。難易度で trace / connect / timing を混ぜる
function generateGuides(difficulty: number): GuidePath[] {
  const count = 1 + Math.floor(difficulty * 2); // 1〜3本
  const guides: GuidePath[] = [];

  const pickType = (idx: number): GuideType => {
    const r = (Math.random() + idx * 0.17) % 1;
    if (difficulty < 0.5) {
      // 初級: なぞる中心、少しだけつなぐ
      return r < 0.85 ? "trace" : "connect";
    }
    if (difficulty < 0.8) {
      // 中級: なぞる主体、つなぐ少々、タイミングはごく稀
      if (r < 0.6) return "trace";
      if (r < 0.9) return "connect";
      return "timing";
    }
    // 上級: 三種だがtrace優先
    if (r < 0.5) return "trace";
    if (r < 0.8) return "connect";
    return "timing";
  };

  for (let i = 0; i < count; i++) {
    const yBase = MARGIN + ((AREA_H - MARGIN * 2) / (count + 1)) * (i + 1);
    const type = pickType(i);
    const len = AREA_W * 0.78;
    const startX = (AREA_W - len) / 2;
    const x1 = startX;
    const x2 = startX + len;

    // 共通: 緩やかなS字 or 弧。なぞりやすい振幅に抑える
    const amp = 14 + Math.random() * 12; // 14〜26px
    const dir = Math.random() < 0.5 ? 1 : -1;
    const sShape = Math.random() < 0.7; // S字優先
    const p0 = { x: x1, y: yBase };
    const p3 = { x: x2, y: yBase };
    const p1 = { x: x1 + len * 0.22, y: yBase + dir * amp };
    const p2 = { x: x1 + len * 0.78, y: yBase + (sShape ? -dir : dir) * amp };
    const samples = sampleCubic(p0, p1, p2, p3, 48);
    const svgPath = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;

    const base: GuidePath = {
      type,
      samples,
      svgPath,
      completed: false,
      accuracy: 0,
      speedBonus: 0,
      modeScore: 1,
    };

    if (type === "connect") {
      // 3〜4個の関節を曲線上に均等配置、順番につなぐ
      const nodeCount = 3 + Math.floor(Math.random() * 2);
      const waypoints: Waypoint[] = [];
      for (let n = 0; n < nodeCount; n++) {
        const t = (n + 1) / (nodeCount + 1);
        const sIdx = Math.round(t * (samples.length - 1));
        waypoints.push({
          x: samples[sIdx].x,
          y: samples[sIdx].y,
          order: n,
          hit: false,
        });
      }
      base.waypoints = waypoints;
      base.modeScore = 0;
    } else if (type === "timing") {
      // 2個のタイミングゲート。ゆったりした拍＆広い窓で通しやすく
      const gateCount = 2;
      const gates: TimingGate[] = [];
      const beat = 650 + Math.random() * 200; // 拍の長さ(ms) ゆったり
      const offset = 450; // 最初のゲートまで余裕を持たせる
      for (let g = 0; g < gateCount; g++) {
        const t = (g + 1) / (gateCount + 1);
        const sIdx = Math.round(t * (samples.length - 1));
        const center = offset + g * beat;
        gates.push({
          x: samples[sIdx].x,
          y: samples[sIdx].y,
          openAt: center - 380, // 窓を広く (760ms)
          closeAt: center + 380,
          hit: false,
        });
      }
      base.gates = gates;
      base.modeScore = 0;
    }

    guides.push(base);
  }
  return guides;
}

// 点から折れ線への最短距離
function distToPolyline(px: number, py: number, samples: { x: number; y: number }[]) {
  let min = Infinity;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy || 1;
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < min) min = d;
  }
  return min;
}

export default function CookingGame({ inventory, marketTrend, onSell }: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [sellMode, setSellMode] = useState<string | null>(null);
  const [activeCut, setActiveCut] = useState<string | null>(null);
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number; t: number }[]>([]);
  const [counter, setCounter] = useState<CounterItem[]>([]);
  const [flash, setFlash] = useState<{ fishId: string; kind: "combo" | "perfect" | "bone"; at: number } | null>(null);
  // タイミングゲートのアニメ用: 描画中はrAFで毎フレーム更新
  const [, setTick] = useState(0);
  const activeRectRef = useRef<DOMRect | null>(null);
  const activeCutRef = useRef<ActiveCutState | null>(null);

  // カット中はrAFでtickを進め、timingゲートのビジュアルを更新
  useEffect(() => {
    if (!activeCut) return;
    let raf = 0;
    const loop = () => {
      setTick((t) => (t + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [activeCut]);

  // 鮮度更新
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const updated: Record<string, number> = {};
      for (const fish of inventory) {
        updated[fish.id] = calculateFreshness(fish.caughtAt, now);
      }
      setFreshness(updated);
    }, 500);
    return () => clearInterval(interval);
  }, [inventory]);

  // カウンターの客到着 & 期限切れチェック
  useEffect(() => {
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
            vibrate([20, 10, 20, 10, 20]);
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
        const cleaned = updated.filter((item) => !item.customerArrived && !item.expired);
        return changed ? cleaned : (cleaned.length !== prev.length ? cleaned : prev);
      });
    }, 300);
    return () => clearInterval(interval);
  }, [onSell]);

  const getClientPos = (e: React.MouseEvent | React.TouchEvent) => {
    if ("touches" in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if ("clientX" in e) {
      return { x: e.clientX, y: e.clientY };
    }
    return null;
  };

  const toRelative = (clientX: number, clientY: number) => {
    const rect = activeRectRef.current;
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  // 区間を確定して精度/速度ボーナスを計算
  const finalizeSegment = useCallback((
    active: ActiveCutState,
    segmentPoints: { x: number; y: number; t: number }[],
  ) => {
    const guide = active.guidesSnapshot[active.currentGuide];
    if (!guide || segmentPoints.length < 2) return null;

    // 平均距離 → なぞり精度
    let totalDist = 0;
    for (const pt of segmentPoints) {
      totalDist += distToPolyline(pt.x, pt.y, guide.samples);
    }
    const avgDist = totalDist / segmentPoints.length;
    // 許容ズレを広げ、多少外れても並以上を取りやすく
    let accuracy = Math.max(0, Math.min(1, 1 - avgDist / 75));

    // モード別達成度（つなぐ = ノード通過率、タイミング = ゲート通過率）
    let modeScore = 1;
    if (guide.waypoints && guide.waypoints.length > 0) {
      const hits = guide.waypoints.filter((w) => w.hit).length;
      modeScore = hits / guide.waypoints.length;
    } else if (guide.gates && guide.gates.length > 0) {
      const hits = guide.gates.filter((g) => g.hit).length;
      modeScore = hits / guide.gates.length;
    }
    // モード達成度を精度に反映: ベースを高めにして、未達でも過度に落とさない
    // 達成度0でも精度の55%、達成度1で100%
    accuracy = accuracy * (0.55 + modeScore * 0.45);

    // 速度ジャスト判定: 理想 = pathLen * 3ms/px (ゆっくり目が基準)
    const idealMs = pathLength(guide.samples) * 3;
    const elapsedMs = segmentPoints[segmentPoints.length - 1].t - segmentPoints[0].t;
    const ratio = elapsedMs / idealMs;
    // ジャスト帯を広く (0.4〜2.0)、外れても緩やかに減衰
    let speedBonus: number;
    if (ratio >= 0.4 && ratio <= 2.0) {
      speedBonus = 1;
    } else if (ratio < 0.4) {
      speedBonus = Math.max(0.3, ratio / 0.4);
    } else {
      speedBonus = Math.max(0.3, 1 - (ratio - 2.0) / 3.0);
    }

    return { accuracy, speedBonus, modeScore };
  }, []);

  // カット開始
  const handleCutStart = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    // 既存のガイドを再利用（部分完了の継続）、なければ生成
    const existing = prepProgress[fish.id];
    const fishData = FISH_DATABASE[fish.species];
    const stage = fishData.stages[fish.stageIndex];
    const guides = existing?.guides ?? generateGuides(stage.prepDifficulty);
    const startGuide = existing?.currentGuide ?? 0;

    // guidesをディープコピー（waypoints/gatesのhit状態もリセット）
    const snapshot: GuidePath[] = guides.map((g) => ({
      ...g,
      waypoints: g.waypoints?.map((w) => ({ ...w, hit: g.completed ? w.hit : false })),
      gates: g.gates?.map((ga) => ({ ...ga, hit: g.completed ? ga.hit : false })),
    }));

    activeCutRef.current = {
      fishId: fish.id,
      currentGuide: startGuide,
      segmentStartIdx: 0,
      segmentStartTime: performance.now(),
      comboCount: 0,
      guidesSnapshot: snapshot,
      totalGuides: guides.length,
      accumulatedAccuracy: existing?.guides.filter((g) => g.completed).reduce((s, g) => s + g.accuracy, 0) ?? 0,
      accumulatedSpeedBonus: existing?.guides.filter((g) => g.completed).reduce((s, g) => s + g.speedBonus, 0) ?? 0,
      accumulatedModeScore: existing?.guides.filter((g) => g.completed).reduce((s, g) => s + g.modeScore, 0) ?? 0,
    };
    setActiveCut(fish.id);
    setDrawPoints([{ ...pos, t: performance.now() }]);
  }, [prepProgress]);

  // カット中: カバレッジ達成で自動的に次ガイドへ（一筆書きコンボ）
  const handleCutMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const active = activeCutRef.current;
    if (!active) return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;
    const now = performance.now();

    setDrawPoints((prev) => {
      const next = [...prev, { ...pos, t: now }];
      const guide = active.guidesSnapshot[active.currentGuide];

      // つなぐ: 次のノードに触れたら順次点灯（判定半径を拡大）
      if (guide?.waypoints) {
        const nextWp = guide.waypoints.find((w) => !w.hit);
        if (nextWp && Math.hypot(pos.x - nextWp.x, pos.y - nextWp.y) < 22) {
          nextWp.hit = true;
          vibrate([10]);
        }
      }

      // タイミング合わせ: 窓が開いている間にゲート位置に触れたらヒット（半径拡大）
      if (guide?.gates) {
        const elapsed = now - active.segmentStartTime;
        for (const gate of guide.gates) {
          if (gate.hit) continue;
          const near = Math.hypot(pos.x - gate.x, pos.y - gate.y) < 26;
          const inWindow = elapsed >= gate.openAt && elapsed <= gate.closeAt;
          if (near && inWindow) {
            gate.hit = true;
            vibrate([12]);
          }
        }
      }

      // 自動確定判定: 現ガイドの終点近傍 & カバレッジ十分
      if (guide) {
        const endSample = guide.samples[guide.samples.length - 1];
        const distToEnd = Math.hypot(pos.x - endSample.x, pos.y - endSample.y);
        const segPts = next.slice(active.segmentStartIdx);
        const startPt = segPts[0];
        const spanX = Math.abs(pos.x - startPt.x);
        const guideSpanX = Math.abs(endSample.x - guide.samples[0].x);
        const coverage = guideSpanX > 0 ? spanX / guideSpanX : 0;

        if (distToEnd < 30 && coverage > 0.65 && segPts.length >= 3) {
          // 確定！
          const result = finalizeSegment(active, segPts);
          if (result) {
            const g = active.guidesSnapshot[active.currentGuide];
            g.completed = true;
            g.accuracy = result.accuracy;
            g.speedBonus = result.speedBonus;
            g.modeScore = result.modeScore;
            active.accumulatedAccuracy += result.accuracy;
            active.accumulatedSpeedBonus += result.speedBonus;
            active.accumulatedModeScore += result.modeScore;
            active.comboCount += 1;
            active.currentGuide += 1;
            active.segmentStartIdx = next.length - 1; // 新区間開始
            active.segmentStartTime = now;

            playSESlice();
            if (result.accuracy > 0.8 && result.speedBonus > 0.8) {
              vibrate([15, 5, 35]);
              setFlash({ fishId: active.fishId, kind: "combo", at: now });
            } else {
              vibrate([12]);
            }

            // 全ガイド完了
            if (active.currentGuide >= active.totalGuides) {
              const perfect = active.comboCount === active.totalGuides;
              const avgAcc = active.accumulatedAccuracy / active.totalGuides;
              const avgSpeed = active.accumulatedSpeedBonus / active.totalGuides;
              // 速度ボーナスを精度に融合（0.5〜1.0の重み）
              const combinedAcc = Math.min(1, avgAcc * (0.7 + 0.3 * avgSpeed) * (perfect ? 1.15 : 1));

              setPrepProgress((prev) => ({
                ...prev,
                [active.fishId]: {
                  fishId: active.fishId,
                  guides: active.guidesSnapshot.map((g) => ({ ...g })),
                  currentGuide: active.totalGuides,
                  state: "done",
                  avgAccuracy: combinedAcc,
                  maxCombo: active.comboCount,
                  perfect,
                },
              }));
              vibrate([30, 10, 30, 10, 60]);
              playSEPrepDone();
              if (perfect) setFlash({ fishId: active.fishId, kind: "perfect", at: now });
              activeCutRef.current = null;
              setActiveCut(null);
              return [];
            }
          }
        }
      }
      return next;
    });
  }, [finalizeSegment]);

  // 指離し: 未完了なら部分結果を保存、コンボはリセット
  const handleCutEnd = useCallback(() => {
    const active = activeCutRef.current;
    if (!active) {
      setActiveCut(null);
      setDrawPoints([]);
      return;
    }

    // 完了済みガイドだけで進捗保存
    const completedCount = active.currentGuide;
    if (completedCount > 0) {
      const avgAcc = active.accumulatedAccuracy / completedCount;
      const avgSpeed = active.accumulatedSpeedBonus / completedCount;
      const combinedAcc = Math.min(1, avgAcc * (0.7 + 0.3 * avgSpeed));
      setPrepProgress((prev) => ({
        ...prev,
        [active.fishId]: {
          fishId: active.fishId,
          guides: active.guidesSnapshot.map((g) => ({ ...g })),
          currentGuide: completedCount,
          state: completedCount >= active.totalGuides ? "done" : "cutting",
          avgAccuracy: combinedAcc,
          maxCombo: Math.max(prev[active.fishId]?.maxCombo ?? 0, active.comboCount),
          perfect: prev[active.fishId]?.perfect ?? false,
        },
      }));
    }

    activeCutRef.current = null;
    setActiveCut(null);
    setDrawPoints([]);
  }, []);

  // 即売り
  const handleInstantSell = (fish: CaughtFish) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;
    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const prep = prepProgress[fish.id];
    const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1; // 精度で0.7~1.0倍
    const price = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult);
    onSell(fish.id, price);
    setSellMode(null);
    playSESell();
  };

  // 限定メニュー
  const handlePlaceOnCounter = (fish: CaughtFish) => {
    const fishFreshness = freshness[fish.id] ?? 100;
    if (fishFreshness <= 0) return;
    const activeCounter = counter.filter((c) => !c.customerArrived && !c.expired);
    if (activeCounter.length >= MAX_COUNTER_SLOTS) return;

    const trendMult = marketTrend[fish.species] ?? 1;
    const freshMult = fishFreshness / 100;
    const prep = prepProgress[fish.id];
    const qualityMult = prep ? 0.8 + prep.avgAccuracy * 0.7 : 1; // 精度で0.8~1.5倍（限定は精度ボーナス大）
    const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMult);

    const rarityBonus = fish.sushiPrice > 2000 ? 0.6 : fish.sushiPrice > 800 ? 0.8 : 1.0;
    const waitTime = COUNTER_BASE_WAIT + Math.random() * (COUNTER_MAX_WAIT - COUNTER_BASE_WAIT) * rarityBonus;

    setCounter((prev) => [
      ...prev,
      { fishId: fish.id, price: premiumPrice, placedAt: Date.now(), waitTime, customerArrived: false, expired: false },
    ]);
    setSellMode(null);
  };

  const activeCounterCount = counter.filter((c) => !c.customerArrived && !c.expired).length;
  const counterFull = activeCounterCount >= MAX_COUNTER_SLOTS;

  // 精度ラベル
  const accuracyLabel = (acc: number) => {
    if (acc >= 0.85) return { text: "極上", color: "text-yellow-500", icon: "✨" };
    if (acc >= 0.6) return { text: "上物", color: "text-green-500", icon: "○" };
    if (acc >= 0.35) return { text: "並", color: "text-gray-500", icon: "△" };
    return { text: "雑", color: "text-red-400", icon: "✕" };
  };

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
          const isDone = prep?.state === "done";
          const isRotten = fishFreshness <= 0;
          const isRare = fishData.reverseValue && fish.stageIndex === 0;

          const trendMult = marketTrend[fish.species] ?? 1;
          const freshMult = (fishFreshness ?? 100) / 100;
          const qualityMult = prep ? 0.7 + prep.avgAccuracy * 0.3 : 1;
          const qualityMultPremium = prep ? 0.8 + prep.avgAccuracy * 0.7 : 1;
          const instantPrice = Math.round(fish.sushiPrice * trendMult * freshMult * qualityMult);
          const premiumPrice = Math.round(fish.sushiPrice * trendMult * freshMult * 2.0 * qualityMultPremium);

          // ガイド線の初期化
          const guides = prep?.guides ?? generateGuides(stage.prepDifficulty);
          const currentGuideIdx = prep?.currentGuide ?? 0;

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

              {/* 捌きエリア or 販売 */}
              {isRotten ? (
                <div className="text-center text-gray-400 text-sm py-2">鮮度が落ちてしまいました...</div>
              ) : !isDone ? (
                /* ---- 精密カットエリア ---- */
                <div

                  className="relative bg-gradient-to-b from-amber-50 to-amber-100 rounded-lg overflow-hidden select-none touch-none border border-amber-200"
                  style={{ height: 140 }}
                  onMouseDown={(e) => handleCutStart(fish, e)}
                  onMouseMove={(e) => handleCutMove(e)}
                  onMouseUp={() => handleCutEnd()}
                  onMouseLeave={() => { if (activeCut) handleCutEnd(); }}
                  onTouchStart={(e) => handleCutStart(fish, e)}
                  onTouchMove={(e) => handleCutMove(e)}
                  onTouchEnd={() => handleCutEnd()}
                >
                  {/* まな板テクスチャ */}
                  <div className="absolute inset-0 opacity-30"
                    style={{
                      backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 35px, rgba(180,140,80,0.2) 35px, rgba(180,140,80,0.2) 36px)",
                    }}
                  />

                  {/* 魚イラスト */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-4xl opacity-25" style={{
                      transform: `scale(${0.8 + stage.silhouetteScale * 0.4})`,
                    }}>
                      🐟
                    </div>
                  </div>

                  {/* ガイド線 */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    {guides.map((guide, i) => {
                      const isCurrent = i === currentGuideIdx;
                      const stroke = guide.completed
                        ? guide.accuracy > 0.7 ? "rgba(34,197,94,0.65)" : guide.accuracy > 0.4 ? "rgba(234,179,8,0.55)" : "rgba(239,68,68,0.45)"
                        : isCurrent ? "rgba(59,130,246,0.75)" : "rgba(0,0,0,0.12)";
                      const strokeWidth = guide.completed ? 3 : isCurrent ? 2.5 : 1.5;
                      const startPt = guide.samples[0];
                      const endPt = guide.samples[guide.samples.length - 1];
                      const midPt = guide.samples[Math.floor(guide.samples.length / 2)];

                      // timingゲートのアニメ: 現在のガイドならsegmentStartTimeからの経過を使う
                      const activeRef = activeCutRef.current;
                      const elapsed = isCurrent && activeRef && activeRef.fishId === fish.id
                        ? performance.now() - activeRef.segmentStartTime
                        : 0;

                      return (
                        <g key={i}>
                          {/* ガイド曲線本体 */}
                          <path
                            d={guide.svgPath}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={strokeWidth}
                            strokeDasharray={guide.completed ? "none" : "6,4"}
                            strokeLinecap="round"
                          />

                          {/* 始点・終点マーカー */}
                          {!guide.completed && isCurrent && (
                            <>
                              <circle cx={startPt.x} cy={startPt.y} r={5} fill="rgba(59,130,246,0.6)" />
                              <circle cx={endPt.x} cy={endPt.y} r={5} fill="rgba(59,130,246,0.6)" />
                            </>
                          )}

                          {/* つなぐ: 関節ノード */}
                          {guide.waypoints?.map((w, wi) => (
                            <g key={`w${wi}`}>
                              <circle
                                cx={w.x} cy={w.y}
                                r={w.hit ? 7 : 6}
                                fill={w.hit ? "rgba(34,197,94,0.85)" : "rgba(255,255,255,0.9)"}
                                stroke={w.hit ? "#16a34a" : isCurrent ? "#2563eb" : "#9ca3af"}
                                strokeWidth={1.5}
                              />
                              <text
                                x={w.x} y={w.y + 3}
                                textAnchor="middle"
                                fontSize={9}
                                fontWeight="bold"
                                fill={w.hit ? "#fff" : "#374151"}
                              >
                                {w.order + 1}
                              </text>
                            </g>
                          ))}

                          {/* タイミング: リズムゲート */}
                          {guide.gates?.map((gate, gi) => {
                            const open = isCurrent && elapsed >= gate.openAt && elapsed <= gate.closeAt && !gate.hit;
                            const closed = isCurrent && elapsed > gate.closeAt && !gate.hit;
                            const fill = gate.hit
                              ? "rgba(234,179,8,0.9)"
                              : closed
                              ? "rgba(239,68,68,0.35)"
                              : open
                              ? "rgba(234,179,8,0.75)"
                              : "rgba(255,255,255,0.85)";
                            const r = open ? 10 : 7;
                            const strokeColor = gate.hit ? "#ca8a04" : closed ? "#ef4444" : open ? "#eab308" : isCurrent ? "#2563eb" : "#9ca3af";
                            return (
                              <g key={`g${gi}`}>
                                {open && (
                                  <circle
                                    cx={gate.x} cy={gate.y}
                                    r={14}
                                    fill="none"
                                    stroke="rgba(234,179,8,0.6)"
                                    strokeWidth={2}
                                  />
                                )}
                                <circle
                                  cx={gate.x} cy={gate.y}
                                  r={r}
                                  fill={fill}
                                  stroke={strokeColor}
                                  strokeWidth={1.8}
                                />
                                {gate.hit && (
                                  <text x={gate.x} y={gate.y + 3} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#fff">♪</text>
                                )}
                              </g>
                            );
                          })}

                          {/* 完了マーク */}
                          {guide.completed && (
                            <text
                              x={midPt.x}
                              y={midPt.y - 10}
                              textAnchor="middle"
                              fontSize={11}
                              fill={guide.accuracy > 0.7 ? "#22c55e" : guide.accuracy > 0.4 ? "#eab308" : "#ef4444"}
                              fontWeight="bold"
                            >
                              {guide.accuracy > 0.7 ? "✨" : guide.accuracy > 0.4 ? "○" : "△"}
                            </text>
                          )}
                        </g>
                      );
                    })}

                    {/* プレイヤーの描画線 */}
                    {drawPoints.length > 1 && (
                      <polyline
                        points={drawPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                        fill="none"
                        stroke="rgba(220, 50, 50, 0.7)"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>

                  {/* ヒント */}
                  <div className="absolute bottom-1 left-0 right-0 text-center">
                    <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
                      {(() => {
                        const g = guides[currentGuideIdx];
                        if (!g) return `${currentGuideIdx + 1}/${guides.length}`;
                        const label =
                          g.type === "connect" ? "① → ② → ③ 順につなげ" :
                          g.type === "timing"  ? "光る瞬間に ♪ ゲートを通せ" :
                                                  "曲線に沿って一息でなぞれ";
                        return `${label}（${currentGuideIdx + 1}/${guides.length}）`;
                      })()}
                    </span>
                  </div>

                  {isRare && (
                    <div className="absolute top-1 right-1">
                      <span className="text-xs bg-red-500 text-white px-1.5 py-0.5 rounded font-bold">極細</span>
                    </div>
                  )}
                </div>
              ) : sellMode === fish.id ? (
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
                        {counterFull ? `カウンター満席` : "高単価・客待ちあり"}
                      </span>
                    </div>
                    <span className="text-lg">¥{premiumPrice.toLocaleString()}</span>
                  </button>
                  <button onClick={() => setSellMode(null)} className="w-full text-gray-400 text-xs py-1">戻る</button>
                </div>
              ) : (
                <button
                  onClick={() => setSellMode(fish.id)}
                  className="w-full bg-green-500 hover:bg-green-600 text-white py-3 rounded-lg font-bold transition-all active:scale-95"
                >
                  🍣 握って売る！
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
