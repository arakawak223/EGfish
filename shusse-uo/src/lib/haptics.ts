// Web Haptics API (Vibration API) ラッパー
// スマホのバイブレーション連動

export function vibrate(pattern: readonly number[] | number[]): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}

// プリセットパターン
export const HAPTIC_PATTERNS = {
  hit: [100, 30, 200],       // ヒット時「ガツン」
  miss: [30, 50, 30],        // バラシ時
  reel: [50, 50],            // リール巻き
  sell: [20, 10, 20, 10, 20], // 販売成功「チャリン」
  perfect: [50, 30, 100, 30, 200, 30, 300], // パーフェクトキャッチ
  // 調理用ハプティクス
  knifeEntry: [40, 10, 15],               // 包丁が入る「トクッ」
  smoothSlide: [8, 8],                     // 骨に沿う「スルスル」
  boneResist: [30, 10, 30, 10, 30],       // 骨に当たる「ガガガッ」
  riceGrab: [20, 5, 10],                  // シャリを取る「サクッ」
  pinch: [15, 5, 25],                     // ネタを合わせる「ペタッ」
  pressPerfect: [10, 5, 8, 5, 6, 5, 4],  // 完璧な握り「フワッ」（減衰振動）
  pressSoft: [5, 10, 5],                  // 弱すぎ（頼りない）
  pressHard: [80, 20, 80],               // 強すぎ（硬い）
} as const;

export function vibrateHit(): void {
  vibrate(HAPTIC_PATTERNS.hit);
}

export function vibrateMiss(): void {
  vibrate(HAPTIC_PATTERNS.miss);
}

export function vibrateFishSpecific(pattern: number[]): void {
  vibrate(pattern);
}
