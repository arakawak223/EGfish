"use client";

import { useState, useEffect } from "react";
import { Trophy, ArrowLeft } from "lucide-react";

interface RankingEntry {
  name: string;
  totalAssets: number;
  shopRank: string;
  day: number;
}

const SHOP_RANK_DISPLAY: Record<string, string> = {
  yatai: "屋台",
  kaiten: "回転寿司",
  ginza: "銀座の名店",
};

interface RankingBoardProps {
  playerName: string;
  onClose: () => void;
}

export default function RankingBoard({ playerName, onClose }: RankingBoardProps) {
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/rankings")
      .then((res) => res.json())
      .then((data) => {
        setRankings(data.rankings ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-b from-amber-100 to-orange-200 text-gray-800">
      {/* ヘッダー */}
      <div className="bg-amber-500 text-white px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onClose} className="hover:bg-amber-600 rounded-full p-1 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <Trophy className="w-5 h-5" />
        <h2 className="font-bold text-lg">ランキング</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="text-center py-12 text-gray-500">読み込み中...</div>
        ) : rankings.length === 0 ? (
          <div className="text-center py-12">
            <Trophy className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500">まだランキングデータがありません</p>
            <p className="text-gray-400 text-sm mt-1">ゲームをプレイしてスコアを登録しよう！</p>
          </div>
        ) : (
          <div className="space-y-2 max-w-md mx-auto">
            {rankings.map((entry, i) => {
              const isMe = entry.name === playerName;
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
              return (
                <div
                  key={`${entry.name}-${i}`}
                  className={`flex items-center gap-3 bg-white rounded-xl p-3 shadow-sm ${
                    isMe ? "ring-2 ring-orange-400 bg-orange-50" : ""
                  }`}
                >
                  <div className="w-8 text-center text-lg font-bold shrink-0">
                    {medal}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <span className={`font-bold truncate ${isMe ? "text-orange-600" : ""}`}>
                        {entry.name}
                      </span>
                      {isMe && (
                        <span className="text-xs bg-orange-400 text-white px-1.5 py-0.5 rounded-full shrink-0">
                          YOU
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {SHOP_RANK_DISPLAY[entry.shopRank] ?? "屋台"} ・ {entry.day}日目
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-bold text-green-600">
                      ¥{entry.totalAssets.toLocaleString()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
