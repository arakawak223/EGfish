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
