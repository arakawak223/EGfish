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
  // 時間倍率: 大きいほど「ゆっくり」= タイミング窓が広く、理想カット時間が長い
  timeMultiplier?: number;
  paused?: boolean;
}

type PrepState = "idle" | "cutting" | "done";

// 一閃さばき: 魚体に矢印の直線が1〜3本。始点から終点へ一気にスワイプして断つ。
// 難度が上がると本数が増える（1本=頭落とし / 2本=二枚 / 3本=三枚おろし）。
interface Slash {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  label: string;
  completed: boolean;
  accuracy: number;   // 0~1 方向×直線度×カバレッジ
  speedScore: number; // 0~1 決断力（速いほど良い）
}

interface PrepProgress {
  fishId: string;
  slashes: Slash[];
  currentSlash: number;
  state: PrepState;
  avgAccuracy: number;
  perfect: boolean;
}

// 進行中のスワイプ状態（ref管理・handleCutMove中に変更するためstate化しない）
interface ActiveCutState {
  fishId: string;
  slashIndex: number;
  slashesSnapshot: Slash[];
  totalSlashes: number;
  segmentStartTime: number;
  segmentStartIdx: number; // drawPoints内の現スラッシュ開始点
  accumulatedAccuracy: number;
  accumulatedSpeedScore: number;
  completedCount: number;
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

// 魚ごとに一閃さばきのラインを生成。常に左→右の水平カット。
// 本数は難度で決まる: 1本=頭落とし / 2本=二枚おろし / 3本=三枚おろし
function generateSlashes(difficulty: number): Slash[] {
  const left = MARGIN;
  const right = AREA_W - MARGIN;
  const cy = AREA_H / 2;
  const mk = (dy: number, label: string): Slash => ({
    startX: left,
    startY: cy + dy,
    endX: right,
    endY: cy + dy,
    label,
    completed: false,
    accuracy: 0,
    speedScore: 0,
  });

  if (difficulty < 0.45) {
    return [mk(0, "一閃")];
  }
  if (difficulty < 0.8) {
    return [mk(-22, "上身"), mk(22, "下身")];
  }
  return [mk(-34, "上身"), mk(0, "中骨"), mk(34, "下身")];
}

export default function CookingGame({ inventory, marketTrend, onSell, timeMultiplier = 1, paused = false }: CookingGameProps) {
  const [prepProgress, setPrepProgress] = useState<Record<string, PrepProgress>>({});
  const [freshness, setFreshness] = useState<Record<string, number>>({});
  const [sellMode, setSellMode] = useState<string | null>(null);
  const [activeCut, setActiveCut] = useState<string | null>(null);
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number; t: number }[]>([]);
  const [counter, setCounter] = useState<CounterItem[]>([]);
  const [flash, setFlash] = useState<{ fishId: string; kind: "combo" | "perfect" | "bone"; at: number } | null>(null);
  const activeRectRef = useRef<DOMRect | null>(null);
  const activeCutRef = useRef<ActiveCutState | null>(null);

  // 一時停止中にカット中だった場合はキャンセルしておく（指を離した扱い）
  useEffect(() => {
    if (paused && activeCutRef.current) {
      activeCutRef.current = null;
      setActiveCut(null);
      setDrawPoints([]);
    }
  }, [paused]);

  // 一時停止から復帰したときにカウンターの placedAt を遅延分シフト
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

  // カウンターの客到着 & 期限切れチェック
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
  }, [onSell, paused]);

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

  // 1本のスラッシュを確定して精度/速さを計算
  const finalizeSlash = useCallback((
    active: ActiveCutState,
    segmentPoints: { x: number; y: number; t: number }[],
  ) => {
    const slash = active.slashesSnapshot[active.slashIndex];
    if (!slash || segmentPoints.length < 2) return null;

    const first = segmentPoints[0];
    const last = segmentPoints[segmentPoints.length - 1];
    const playerDX = last.x - first.x;
    const playerDY = last.y - first.y;
    const playerLen = Math.hypot(playerDX, playerDY);
    if (playerLen < 20) return null;

    const targetDX = slash.endX - slash.startX;
    const targetDY = slash.endY - slash.startY;
    const targetLen = Math.hypot(targetDX, targetDY);

    // 方向一致度 (コサイン類似度、負ならゼロ)
    const dot = (playerDX * targetDX + playerDY * targetDY) / (playerLen * targetLen);
    const directionScore = Math.max(0, dot);

    // 直線度: 端点直線距離 / 実描画長 (曲がりが少ないほど 1 に近い)
    let totalDrawn = 0;
    for (let i = 1; i < segmentPoints.length; i++) {
      totalDrawn += Math.hypot(
        segmentPoints[i].x - segmentPoints[i - 1].x,
        segmentPoints[i].y - segmentPoints[i - 1].y,
      );
    }
    const straightRatio = playerLen / Math.max(totalDrawn, 1);
    // 0.55 を下限、0.95 を上限として 0〜1 に正規化。ちょっとブレても上物以上は取れる
    const straightnessScore = Math.max(0, Math.min(1, (straightRatio - 0.55) / 0.4));

    // カバレッジ: 目標長のどれだけをカバーしたか
    const coverageScore = Math.min(1, playerLen / targetLen);

    // 総合精度: 方向を基軸に、直線度とカバレッジで重み付け
    const accuracy = Math.max(0, Math.min(1,
      directionScore * (0.25 + 0.35 * straightnessScore + 0.40 * coverageScore)
    ));

    // 速さ: 理想時間内なら満点、超えたらゆるやかに減衰（決断力を評価）
    const idealMs = targetLen * 3 * timeMultiplier;
    const elapsedMs = last.t - first.t;
    const speedScore =
      elapsedMs <= idealMs
        ? 1
        : Math.max(0.3, 1 - (elapsedMs - idealMs) / (idealMs * 2));

    return { accuracy, speedScore };
  }, [timeMultiplier]);

  // カット開始: 現スラッシュの始点近傍でのみ反応（誤タップ防止）
  const handleCutStart = useCallback((fish: CaughtFish, e: React.MouseEvent | React.TouchEvent) => {
    const target = e.currentTarget as HTMLElement;
    activeRectRef.current = target.getBoundingClientRect();
    const client = getClientPos(e);
    if (!client) return;
    const pos = toRelative(client.x, client.y);
    if (!pos) return;

    const existing = prepProgress[fish.id];
    const fishData = FISH_DATABASE[fish.species];
    const stage = fishData.stages[fish.stageIndex];
    const slashes = existing?.slashes ?? generateSlashes(stage.prepDifficulty);
    const startIdx = existing?.currentSlash ?? 0;
    if (startIdx >= slashes.length) return;

    // 現スラッシュの始点から一定以上離れていたら反応しない
    const current = slashes[startIdx];
    const distToStart = Math.hypot(pos.x - current.startX, pos.y - current.startY);
    if (distToStart > 42) return;

    const snapshot: Slash[] = slashes.map((s) => ({ ...s }));

    activeCutRef.current = {
      fishId: fish.id,
      slashIndex: startIdx,
      slashesSnapshot: snapshot,
      totalSlashes: snapshot.length,
      segmentStartTime: performance.now(),
      segmentStartIdx: 0,
      accumulatedAccuracy:
        existing?.slashes.filter((s) => s.completed).reduce((a, s) => a + s.accuracy, 0) ?? 0,
      accumulatedSpeedScore:
        existing?.slashes.filter((s) => s.completed).reduce((a, s) => a + s.speedScore, 0) ?? 0,
      completedCount: existing?.slashes.filter((s) => s.completed).length ?? 0,
    };
    setActiveCut(fish.id);
    setDrawPoints([{ ...pos, t: performance.now() }]);
  }, [prepProgress]);

  // ドラッグ中: 終点近傍に達したら自動確定して次のスラッシュへ
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
      const slash = active.slashesSnapshot[active.slashIndex];
      if (!slash) return next;

      const distToEnd = Math.hypot(pos.x - slash.endX, pos.y - slash.endY);
      const segPts = next.slice(active.segmentStartIdx);

      if (distToEnd < 32 && segPts.length >= 3) {
        const result = finalizeSlash(active, segPts);
        if (result) {
          slash.completed = true;
          slash.accuracy = result.accuracy;
          slash.speedScore = result.speedScore;
          active.accumulatedAccuracy += result.accuracy;
          active.accumulatedSpeedScore += result.speedScore;
          active.completedCount += 1;
          active.slashIndex += 1;
          active.segmentStartIdx = next.length - 1;
          active.segmentStartTime = now;

          playSESlice();
          if (result.accuracy > 0.75 && result.speedScore > 0.8) {
            vibrate([15, 5, 35]);
            setFlash({ fishId: active.fishId, kind: "combo", at: now });
          } else {
            vibrate([12]);
          }

          // 全スラッシュ完了
          if (active.slashIndex >= active.totalSlashes) {
            const avgAcc = active.accumulatedAccuracy / active.totalSlashes;
            const avgSpeed = active.accumulatedSpeedScore / active.totalSlashes;
            const perfect = avgAcc >= 0.85 && avgSpeed >= 0.85;
            const combinedAcc = Math.min(1, avgAcc * (0.7 + 0.3 * avgSpeed) * (perfect ? 1.1 : 1));

            setPrepProgress((prevP) => ({
              ...prevP,
              [active.fishId]: {
                fishId: active.fishId,
                slashes: active.slashesSnapshot.map((s) => ({ ...s })),
                currentSlash: active.totalSlashes,
                state: "done",
                avgAccuracy: combinedAcc,
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
      return next;
    });
  }, [finalizeSlash]);

  // 指離し: 未完了なら部分進捗を保存
  const handleCutEnd = useCallback(() => {
    const active = activeCutRef.current;
    if (!active) {
      setActiveCut(null);
      setDrawPoints([]);
      return;
    }

    const completed = active.completedCount;
    if (completed > 0) {
      const avgAcc = active.accumulatedAccuracy / completed;
      const avgSpeed = active.accumulatedSpeedScore / completed;
      const combinedAcc = Math.min(1, avgAcc * (0.7 + 0.3 * avgSpeed));
      setPrepProgress((prev) => ({
        ...prev,
        [active.fishId]: {
          fishId: active.fishId,
          slashes: active.slashesSnapshot.map((s) => ({ ...s })),
          currentSlash: completed,
          state: completed >= active.totalSlashes ? "done" : "cutting",
          avgAccuracy: combinedAcc,
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

          // 一閃さばきラインの初期化
          const slashes = prep?.slashes ?? generateSlashes(stage.prepDifficulty);
          const currentSlashIdx = prep?.currentSlash ?? 0;

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

                  {/* 一閃さばきライン */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    {slashes.map((slash, i) => {
                      const isCurrent = i === currentSlashIdx;
                      const isCompleted = slash.completed;
                      const color = isCompleted
                        ? slash.accuracy > 0.7 ? "#22c55e" : slash.accuracy > 0.4 ? "#eab308" : "#ef4444"
                        : isCurrent ? "#3b82f6" : "#94a3b8";
                      const opacity = isCompleted ? 0.9 : isCurrent ? 1 : 0.35;
                      const midX = (slash.startX + slash.endX) / 2;
                      return (
                        <g key={i} opacity={opacity}>
                          {/* ガイド線本体 */}
                          <line
                            x1={slash.startX} y1={slash.startY}
                            x2={slash.endX - 8} y2={slash.endY}
                            stroke={color}
                            strokeWidth={isCurrent ? 3.5 : isCompleted ? 3 : 2.5}
                            strokeDasharray={isCompleted ? "none" : "8,5"}
                            strokeLinecap="round"
                          />
                          {/* 終点矢印 */}
                          <polygon
                            points={`${slash.endX - 10},${slash.endY - 7} ${slash.endX},${slash.endY} ${slash.endX - 10},${slash.endY + 7}`}
                            fill={color}
                          />
                          {/* 始点マーカー（現在ならパルスで指示） */}
                          <circle
                            cx={slash.startX} cy={slash.startY}
                            r={isCurrent ? 11 : isCompleted ? 7 : 6}
                            fill={isCompleted ? color : isCurrent ? "#dbeafe" : "#fff"}
                            stroke={color}
                            strokeWidth={2}
                            className={isCurrent ? "animate-pulse" : undefined}
                          />
                          <text
                            x={slash.startX} y={slash.startY + 3.5}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight="bold"
                            fill={isCompleted ? "#fff" : isCurrent ? "#1e40af" : color}
                          >
                            {i + 1}
                          </text>
                          {/* ラベル or 完了マーク */}
                          {isCompleted ? (
                            <text
                              x={midX} y={slash.startY - 8}
                              textAnchor="middle"
                              fontSize={12}
                              fontWeight="bold"
                              fill={color}
                            >
                              {slash.accuracy > 0.7 ? "✨" : slash.accuracy > 0.4 ? "○" : "△"}
                            </text>
                          ) : (
                            <text
                              x={midX} y={slash.startY - 7}
                              textAnchor="middle"
                              fontSize={9}
                              fill={color}
                              opacity={isCurrent ? 0.9 : 0.55}
                            >
                              {slash.label}
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
                        stroke="rgba(220, 50, 50, 0.75)"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>

                  {/* ヒント */}
                  <div className="absolute bottom-1 left-0 right-0 text-center">
                    <span className="text-xs bg-black/30 text-white px-2 py-0.5 rounded-full">
                      {(() => {
                        const s = slashes[currentSlashIdx];
                        if (!s) return `${currentSlashIdx + 1}/${slashes.length}`;
                        return `「${s.label}」を一気に右へ引け（${currentSlashIdx + 1}/${slashes.length}）`;
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
