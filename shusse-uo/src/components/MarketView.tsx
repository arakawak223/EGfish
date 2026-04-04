"use client";

import { GameState, SHOP_RANK_NAMES } from "@/lib/game-state";
import { FISH_DATABASE, FishSpecies } from "@/lib/fish-data";
import { TrendingUp, TrendingDown } from "lucide-react";

interface MarketViewProps {
  gameState: GameState;
}

export default function MarketView({ gameState }: MarketViewProps) {
  // 魚種ごとの釣果集計
  const catchStats: Record<string, { count: number; totalValue: number }> = {};
  for (const c of gameState.catches) {
    const key = c.stageName;
    if (!catchStats[key]) catchStats[key] = { count: 0, totalValue: 0 };
    catchStats[key].count++;
    catchStats[key].totalValue += c.basePrice;
  }

  // 販売済み集計
  const soldItems = gameState.inventory.filter((f) => f.sold);
  const totalSold = soldItems.reduce((s, f) => s + (f.soldPrice ?? 0), 0);

  return (
    <div className="h-full bg-gradient-to-b from-green-50 to-emerald-100 overflow-y-auto p-4">
      {/* 店舗ランク */}
      <div className="bg-white rounded-xl shadow-md p-4 mb-4 text-center">
        <div className="text-3xl mb-1">
          {gameState.shopRank === "ginza" ? "🏯" : gameState.shopRank === "kaiten" ? "🍣" : "🏪"}
        </div>
        <h3 className="font-bold text-lg">{SHOP_RANK_NAMES[gameState.shopRank]}</h3>
        <div className="text-sm text-gray-500 mt-1">
          {gameState.shopRank === "yatai" && "次のランク: ¥15,000"}
          {gameState.shopRank === "kaiten" && "次のランク: ¥50,000"}
          {gameState.shopRank === "ginza" && "最高ランク達成！"}
        </div>
        <div className="w-full h-2 bg-gray-200 rounded-full mt-2 overflow-hidden">
          <div
            className="h-full bg-amber-500 rounded-full transition-all"
            style={{
              width: `${Math.min(
                100,
                gameState.shopRank === "yatai"
                  ? (gameState.totalAssets / 15000) * 100
                  : gameState.shopRank === "kaiten"
                  ? ((gameState.totalAssets - 15000) / 35000) * 100
                  : 100
              )}%`,
            }}
          />
        </div>
      </div>

      {/* 市場トレンド詳細 */}
      <div className="bg-white rounded-xl shadow-md p-4 mb-4">
        <h3 className="font-bold mb-3">📈 本日の市場トレンド</h3>
        <div className="space-y-2">
          {(["buri", "suzuki", "maiwashi", "sawara", "konoshiro"] as FishSpecies[]).map(
            (species) => {
              const fish = FISH_DATABASE[species];
              const trend = gameState.marketTrend[species];
              const pct = trend ? Math.round((trend - 1) * 100) : 0;
              return (
                <div key={species} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: fish.color }}
                    />
                    <span className="text-sm">{fish.displayName}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {pct > 0 ? (
                      <TrendingUp className="w-4 h-4 text-green-500" />
                    ) : pct < 0 ? (
                      <TrendingDown className="w-4 h-4 text-red-500" />
                    ) : (
                      <span className="w-4 h-4 text-center text-gray-400">-</span>
                    )}
                    <span
                      className={`text-sm font-bold ${
                        pct > 0 ? "text-green-600" : pct < 0 ? "text-red-600" : "text-gray-500"
                      }`}
                    >
                      {pct > 0 ? "+" : ""}
                      {pct}%
                    </span>
                  </div>
                </div>
              );
            }
          )}
        </div>
      </div>

      {/* 収支サマリー */}
      <div className="bg-white rounded-xl shadow-md p-4 mb-4">
        <h3 className="font-bold mb-3">💰 収支</h3>
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="text-xs text-gray-500">兄（卸売）</div>
            <div className="text-lg font-bold text-blue-600">
              ¥{gameState.brotherMoney.toLocaleString()}
            </div>
          </div>
          <div className="bg-red-50 rounded-lg p-3">
            <div className="text-xs text-gray-500">弟（販売）</div>
            <div className="text-lg font-bold text-red-600">
              ¥{gameState.youngerMoney.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* 釣果ログ */}
      <div className="bg-white rounded-xl shadow-md p-4">
        <h3 className="font-bold mb-3">🐟 釣果ログ</h3>
        {Object.keys(catchStats).length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-3">まだ釣果がありません</p>
        ) : (
          <div className="space-y-1 text-sm">
            {Object.entries(catchStats).map(([name, stats]) => (
              <div key={name} className="flex justify-between">
                <span>
                  {name} ×{stats.count}
                </span>
                <span className="text-gray-600">
                  ¥{stats.totalValue.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
