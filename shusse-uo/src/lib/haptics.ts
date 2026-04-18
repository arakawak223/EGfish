// Haptics ラッパー
// - iOS / Android ネイティブ（Capacitor）: Taptic Engine / VibrationEffect
// - Web: Vibration API（iOS Safariは未対応なので無音で失敗）

import { Capacitor } from "@capacitor/core";
import {
  Haptics,
  ImpactStyle,
  NotificationType,
} from "@capacitor/haptics";

function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// パターン配列をiOS強度プリセットへマッピング
// 既存の vibrate([...]) 呼び出しをそのまま活かすため、
// 奇数index=停止 / 偶数index=振動 の仕様でON時間を見て強度を判定する
function classifyPattern(pattern: readonly number[]):
  | { kind: "impact"; style: ImpactStyle }
  | { kind: "notification"; type: NotificationType } {
  const onDurations = pattern.filter((_, i) => i % 2 === 0).filter((ms) => ms > 0);
  if (onDurations.length === 0) {
    return { kind: "impact", style: ImpactStyle.Light };
  }
  const maxMs = Math.max(...onDurations);
  const pulses = onDurations.length;

  // 5連以上のパターンは「達成系」として通知触覚に寄せる
  if (pulses >= 5 && maxMs >= 100) {
    return { kind: "notification", type: NotificationType.Success };
  }
  if (pulses >= 4 && maxMs <= 40) {
    return { kind: "notification", type: NotificationType.Warning };
  }

  if (maxMs >= 150) return { kind: "impact", style: ImpactStyle.Heavy };
  if (maxMs >= 50) return { kind: "impact", style: ImpactStyle.Medium };
  return { kind: "impact", style: ImpactStyle.Light };
}

export function vibrate(pattern: readonly number[] | number[]): void {
  if (!pattern || pattern.length === 0) return;

  if (isNative()) {
    const c = classifyPattern(pattern);
    if (c.kind === "impact") {
      void Haptics.impact({ style: c.style });
    } else {
      void Haptics.notification({ type: c.type });
    }
    return;
  }

  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern as number[]);
  }
}

// プリセットパターン（Web用の生配列。ネイティブでは classifyPattern 経由で強度に変換）
export const HAPTIC_PATTERNS = {
  hit: [100, 30, 200],
  miss: [30, 50, 30],
  reel: [50, 50],
  sell: [20, 10, 20, 10, 20],
  perfect: [50, 30, 100, 30, 200, 30, 300],
  knifeEntry: [40, 10, 15],
  smoothSlide: [8, 8],
  boneResist: [30, 10, 30, 10, 30],
  riceGrab: [20, 5, 10],
  pinch: [15, 5, 25],
  pressPerfect: [10, 5, 8, 5, 6, 5, 4],
  pressSoft: [5, 10, 5],
  pressHard: [80, 20, 80],
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

// ネイティブ専用：触覚サポート状態を返す（デバッグ・UI表示用）
export function hapticsCapability(): "native" | "web" | "unsupported" {
  if (isNative()) return "native";
  if (typeof navigator !== "undefined" && "vibrate" in navigator) return "web";
  return "unsupported";
}
