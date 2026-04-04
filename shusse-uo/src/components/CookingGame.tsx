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

// ガイド線: プレイヤーがこの線に沿って切る
interface GuideLine {
  x1: number; y1: number;
  x2: number; y2: number;
  completed: boolean;
  accuracy: number; // 0~1, 完了時に計算
}

interface PrepProgress {
  fishId: string;
  guides: GuideLine[];
  currentGuide: number;
  state: PrepState;
  avgAccuracy: number;
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

// 魚ごとにガイド線を生成
function generateGuides(difficulty: number): GuideLine[] {
  const count = 1 + Math.floor(difficulty * 2); // 1〜3本
  const guides: GuideLine[] = [];
  const areaW = 280;
  const areaH = 130;
  const margin = 25;

  for (let i = 0; i < count; i++) {
    // まっすぐな横線を均等配置（傾きなし、狙いやすい）
    const yBase = margin + ((areaH - margin * 2) / (count + 1)) * (i + 1);
    const len = areaW * 0.75; // 長めの線で狙いやすく
    const startX = (areaW - len) / 2;
    guides.push({
      x1: startX,
      y1: yBase,
      x2: startX + len,
      y2: yBase,
      completed: false,
      accuracy: 0,
    });
  }
  return guides;
}

export default function CookingGame({ inventory, marketTrend, onSell }: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [sellMode, setSellMode] = useState<string | null>(null);
  const [activeCut, setActiveCut] = useState<string | null>(null);
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number }[]>([]);
  const [counter, setCounter] = useState<CounterItem[]>([]);
  const activeRectRef = useRef<DOMRect | null>(null);

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

  // カット開始
  const handleCutStart = useCallback((fishId: string, e: React.MouseEvent | React.TouchEvent) => {
    // クリックされた要素のrectを保存
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;
    setActiveCut(fishId);
    setDrawPoints([pos]);
  }, []);

  // カット中
  const handleCutMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!activeCut) return;
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;
    setDrawPoints((prev) => [...prev, pos]);
  }, [activeCut]);

  // カット完了 → ガイド線との精度を計算
  const handleCutEnd = useCallback((fish: CaughtFish) => {
    if (!activeCut || drawPoints.length < 3) {
      setActiveCut(null);
      setDrawPoints([]);
      return;
    }

    const fishData = FISH_DATABASE[fish.species];
    const stage = fishData.stages[fish.stageIndex];

    setPrepProgress((prev) => {
      const existing = prev[fish.id] || {
        fishId: fish.id,
        guides: generateGuides(stage.prepDifficulty),
        currentGuide: 0,
        state: "cutting" as PrepState,
        avgAccuracy: 0,
      };

      if (existing.state === "done") return prev;

      const guide = existing.guides[existing.currentGuide];
      if (!guide) return prev;

      // ガイド線との距離を計算（描いた点群とガイド線の平均距離）
      const gDx = guide.x2 - guide.x1;
      const gDy = guide.y2 - guide.y1;
      const gLen = Math.sqrt(gDx * gDx + gDy * gDy);

      let totalDist = 0;
      for (const pt of drawPoints) {
        // 点からガイド線への垂線距離
        const t = Math.max(0, Math.min(1,
          ((pt.x - guide.x1) * gDx + (pt.y - guide.y1) * gDy) / (gLen * gLen)
        ));
        const closestX = guide.x1 + t * gDx;
        const closestY = guide.y1 + t * gDy;
        const dist = Math.sqrt((pt.x - closestX) ** 2 + (pt.y - closestY) ** 2);
        totalDist += dist;
      }
      const avgDist = totalDist / drawPoints.length;
      // 精度: 距離0=1.0, 距離50以上=0.0（大幅に緩和）
      const accuracy = Math.max(0, Math.min(1, 1 - avgDist / 50));

      // ガイド線にカバレッジがあるか（始点～終点付近を通ったか）
      const drawnStartX = drawPoints[0].x;
      const drawnEndX = drawPoints[drawPoints.length - 1].x;
      const drawnSpan = Math.abs(drawnEndX - drawnStartX);
      const guideSpan = Math.abs(gDx);
      const coverage = drawnSpan / guideSpan;

      if (coverage < 0.25) {
        // 短すぎるスワイプ → やり直し
        return prev;
      }

      // 振動フィードバック
      if (accuracy > 0.7) {
        vibrate([20, 10, 30]);
        playSESlice();
      } else {
        vibrate([10]);
        playSESlice();
      }

      const newGuides = existing.guides.map((g, i) =>
        i === existing.currentGuide ? { ...g, completed: true, accuracy } : g
      );
      const nextGuide = existing.currentGuide + 1;
      const allDone = nextGuide >= newGuides.length;

      // 平均精度を再計算
      const completedGuides = newGuides.filter((g) => g.completed);
      const avgAccuracy = completedGuides.reduce((s, g) => s + g.accuracy, 0) / completedGuides.length;

      if (allDone) {
        vibrate([30, 10, 30, 10, 60]);
        playSEPrepDone();
      }

      return {
        ...prev,
        [fish.id]: {
          ...existing,
          guides: newGuides,
          currentGuide: nextGuide,
          state: allDone ? "done" : "cutting",
          avgAccuracy,
        },
      };
    });

    setActiveCut(null);
    setDrawPoints([]);
  }, [activeCut, drawPoints]);

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
                  onMouseDown={(e) => handleCutStart(fish.id, e)}
                  onMouseMove={(e) => handleCutMove(e)}
                  onMouseUp={() => handleCutEnd(fish)}
                  onMouseLeave={() => { if (activeCut) handleCutEnd(fish); }}
                  onTouchStart={(e) => handleCutStart(fish.id, e)}
                  onTouchMove={(e) => handleCutMove(e)}
                  onTouchEnd={() => handleCutEnd(fish)}
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
                    {guides.map((guide, i) => (
                      <g key={i}>
                        {/* ガイド線本体 */}
                        <line
                          x1={guide.x1} y1={guide.y1}
                          x2={guide.x2} y2={guide.y2}
                          stroke={
                            guide.completed
                              ? guide.accuracy > 0.7 ? "rgba(34,197,94,0.6)" : guide.accuracy > 0.4 ? "rgba(234,179,8,0.5)" : "rgba(239,68,68,0.4)"
                              : i === currentGuideIdx
                              ? "rgba(59,130,246,0.7)"
                              : "rgba(0,0,0,0.12)"
                          }
                          strokeWidth={guide.completed ? 3 : i === currentGuideIdx ? 2.5 : 1.5}
                          strokeDasharray={guide.completed ? "none" : "6,4"}
                          strokeLinecap="round"
                        />
                        {/* 現在のガイド線の端マーカー */}
                        {!guide.completed && i === currentGuideIdx && (
                          <>
                            <circle cx={guide.x1} cy={guide.y1} r={4} fill="rgba(59,130,246,0.5)" />
                            <circle cx={guide.x2} cy={guide.y2} r={4} fill="rgba(59,130,246,0.5)" />
                          </>
                        )}
                        {/* 完了マーク */}
                        {guide.completed && (
                          <text
                            x={(guide.x1 + guide.x2) / 2}
                            y={(guide.y1 + guide.y2) / 2 - 8}
                            textAnchor="middle"
                            fontSize={10}
                            fill={guide.accuracy > 0.7 ? "#22c55e" : guide.accuracy > 0.4 ? "#eab308" : "#ef4444"}
                            fontWeight="bold"
                          >
                            {guide.accuracy > 0.7 ? "✨" : guide.accuracy > 0.4 ? "○" : "△"}
                          </text>
                        )}
                      </g>
                    ))}

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
                      青い線に沿ってなぞる（{currentGuideIdx + 1}/{guides.length}）
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
