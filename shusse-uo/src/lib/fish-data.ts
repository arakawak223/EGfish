// 出世魚データモデル
// 5種の出世魚と成長段階・価格・振動パターンを定義

export type FishSpecies = "buri" | "suzuki" | "maiwashi" | "sawara" | "konoshiro";

export interface FishStage {
  name: string;        // 和名
  size: "small" | "medium" | "large";
  basePrice: number;   // 基本卸値（円）
  sushiPrice: number;  // 寿司販売価格（円）
  silhouetteScale: number; // 魚影の大きさ倍率
  catchDifficulty: number; // 0-1, タイミング判定の厳しさ
  prepDifficulty: number;  // 0-1, 捌き判定の精密さ
}

export interface FishType {
  species: FishSpecies;
  displayName: string;
  stages: FishStage[];
  vibrationPattern: number[]; // Web Haptics API用: [振動ms, 停止ms, ...]
  color: string;              // テーマカラー
  seasonBonus?: { month: number[]; multiplier: number }; // 季節ボーナス
  reverseValue?: boolean; // true = 小さいほど高単価（コノシロ用）
}

export const FISH_DATABASE: Record<FishSpecies, FishType> = {
  buri: {
    species: "buri",
    displayName: "ブリ",
    color: "#1e3a5f",
    vibrationPattern: [200, 50, 200, 50, 300], // 重低音系
    stages: [
      { name: "ワカシ", size: "small", basePrice: 300, sushiPrice: 500, silhouetteScale: 0.4, catchDifficulty: 0.3, prepDifficulty: 0.3 },
      { name: "イナダ", size: "medium", basePrice: 600, sushiPrice: 1000, silhouetteScale: 0.6, catchDifficulty: 0.5, prepDifficulty: 0.4 },
      { name: "ワラサ", size: "large", basePrice: 1200, sushiPrice: 2000, silhouetteScale: 0.8, catchDifficulty: 0.7, prepDifficulty: 0.6 },
      { name: "ブリ", size: "large", basePrice: 2500, sushiPrice: 4000, silhouetteScale: 1.0, catchDifficulty: 0.9, prepDifficulty: 0.7 },
    ],
  },
  suzuki: {
    species: "suzuki",
    displayName: "スズキ",
    color: "#4a7c59",
    vibrationPattern: [100, 30, 150, 30, 100], // 中程度
    seasonBonus: { month: [6, 7, 8], multiplier: 1.5 }, // 夏場ボーナス
    stages: [
      { name: "セイゴ", size: "small", basePrice: 200, sushiPrice: 400, silhouetteScale: 0.4, catchDifficulty: 0.3, prepDifficulty: 0.3 },
      { name: "フッコ", size: "medium", basePrice: 500, sushiPrice: 900, silhouetteScale: 0.65, catchDifficulty: 0.5, prepDifficulty: 0.5 },
      { name: "スズキ", size: "large", basePrice: 1000, sushiPrice: 1800, silhouetteScale: 0.9, catchDifficulty: 0.7, prepDifficulty: 0.6 },
    ],
  },
  maiwashi: {
    species: "maiwashi",
    displayName: "マイワシ",
    color: "#6b8fa3",
    vibrationPattern: [30, 20, 30, 20, 30], // 軽い連続
    stages: [
      { name: "シラス", size: "small", basePrice: 400, sushiPrice: 1200, silhouetteScale: 0.2, catchDifficulty: 0.6, prepDifficulty: 0.8 }, // 軍艦で高単価
      { name: "カエリ", size: "small", basePrice: 200, sushiPrice: 500, silhouetteScale: 0.3, catchDifficulty: 0.4, prepDifficulty: 0.5 },
      { name: "イワシ", size: "medium", basePrice: 150, sushiPrice: 350, silhouetteScale: 0.5, catchDifficulty: 0.3, prepDifficulty: 0.3 },
    ],
  },
  sawara: {
    species: "sawara",
    displayName: "サワラ",
    color: "#8b6e4e",
    vibrationPattern: [50, 10, 50, 10, 50, 10, 50], // 鋭い連続
    stages: [
      { name: "サゴシ", size: "small", basePrice: 350, sushiPrice: 600, silhouetteScale: 0.45, catchDifficulty: 0.4, prepDifficulty: 0.4 },
      { name: "ナギ", size: "medium", basePrice: 700, sushiPrice: 1200, silhouetteScale: 0.7, catchDifficulty: 0.6, prepDifficulty: 0.5 },
      { name: "サワラ", size: "large", basePrice: 1500, sushiPrice: 3000, silhouetteScale: 0.95, catchDifficulty: 0.8, prepDifficulty: 0.7 }, // 炙り加工で高単価
    ],
  },
  konoshiro: {
    species: "konoshiro",
    displayName: "コノシロ",
    color: "#c0a060",
    vibrationPattern: [40, 30, 60, 30, 40],
    reverseValue: true, // 小さいほど超高単価
    stages: [
      // コノシロ特殊: 小さいほど高い！シンコが最高値
      { name: "シンコ", size: "small", basePrice: 2000, sushiPrice: 5000, silhouetteScale: 0.2, catchDifficulty: 0.9, prepDifficulty: 0.95 },
      { name: "コハダ", size: "small", basePrice: 800, sushiPrice: 2000, silhouetteScale: 0.35, catchDifficulty: 0.6, prepDifficulty: 0.7 },
      { name: "ナカズミ", size: "medium", basePrice: 300, sushiPrice: 600, silhouetteScale: 0.55, catchDifficulty: 0.4, prepDifficulty: 0.4 },
      { name: "コノシロ", size: "medium", basePrice: 100, sushiPrice: 200, silhouetteScale: 0.7, catchDifficulty: 0.2, prepDifficulty: 0.2 },
    ],
  },
};

// 魚影から出世段階をランダム決定（出現確率は段階で異なる）
export function rollFishStage(species: FishSpecies): number {
  const fish = FISH_DATABASE[species];
  const weights = fish.stages.map((_, i) => {
    if (fish.reverseValue) {
      // コノシロ: 小さいほどレア（シンコは超レア）
      // シンコ:1, コハダ:4, ナカズミ:8, コノシロ:12
      return (i + 1) * (i + 1) * 0.8 + 0.2;
    }
    // 通常: 若い段階が出やすいが、最終段階も適度に出る
    // 例: ブリ4段階 → [6, 4, 2.5, 1.5]
    const rarity = fish.stages.length - i;
    return rarity * 1.5 + 0.5;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return 0;
}

// ランダム魚種を選択（出現率に重み付け）
export function rollFishSpecies(): FishSpecies {
  // マイワシ・コノシロは群れやすい → やや出やすい
  const weighted: [FishSpecies, number][] = [
    ["buri", 3],
    ["suzuki", 3],
    ["maiwashi", 4],
    ["sawara", 3],
    ["konoshiro", 4],
  ];
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [species, weight] of weighted) {
    roll -= weight;
    if (roll <= 0) return species;
  }
  return "maiwashi";
}

// 季節ボーナス計算
export function getSeasonMultiplier(fish: FishType): number {
  if (!fish.seasonBonus) return 1;
  const currentMonth = new Date().getMonth() + 1;
  return fish.seasonBonus.month.includes(currentMonth) ? fish.seasonBonus.multiplier : 1;
}
