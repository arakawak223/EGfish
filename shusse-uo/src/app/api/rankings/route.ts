import { NextRequest, NextResponse } from "next/server";

// ランキングエントリ
interface RankingEntry {
  name: string;
  totalAssets: number;
  shopRank: string;
  day: number;
  submittedAt: number;
}

// Vercel KV が設定されていれば使う、なければインメモリ fallback
let kv: { zrange: Function; zadd: Function } | null = null;
const RANKING_KEY = "rankings";
const MAX_RANKINGS = 50;

// インメモリ fallback（cold start でリセットされるがデモには十分）
let memoryRankings: RankingEntry[] = [];

async function getKV() {
  if (kv) return kv;
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const mod = await import("@vercel/kv");
      kv = mod.kv;
      return kv;
    }
  } catch {}
  return null;
}

// GET: ランキング取得
export async function GET() {
  try {
    const store = await getKV();
    if (store) {
      const entries = await store.zrange(RANKING_KEY, 0, MAX_RANKINGS - 1, { rev: true, withScores: true });
      // zrange returns [member, score, member, score, ...]
      const rankings: RankingEntry[] = [];
      for (let i = 0; i < entries.length; i += 2) {
        try {
          const entry = typeof entries[i] === "string" ? JSON.parse(entries[i] as string) : entries[i];
          rankings.push(entry as RankingEntry);
        } catch {}
      }
      return NextResponse.json({ rankings });
    }
    // fallback: メモリ
    const sorted = [...memoryRankings].sort((a, b) => b.totalAssets - a.totalAssets).slice(0, MAX_RANKINGS);
    return NextResponse.json({ rankings: sorted });
  } catch {
    return NextResponse.json({ rankings: memoryRankings }, { status: 200 });
  }
}

// POST: スコア送信
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, totalAssets, shopRank, day } = body;

    if (!name || typeof totalAssets !== "number") {
      return NextResponse.json({ error: "Invalid data" }, { status: 400 });
    }

    const entry: RankingEntry = {
      name: String(name).slice(0, 20),
      totalAssets,
      shopRank: shopRank || "yatai",
      day: day || 1,
      submittedAt: Date.now(),
    };

    const store = await getKV();
    if (store) {
      await store.zadd(RANKING_KEY, { score: totalAssets, member: JSON.stringify(entry) });
      return NextResponse.json({ success: true });
    }

    // fallback: メモリ
    // 同じ名前の古いエントリがあれば高い方を残す
    const existing = memoryRankings.findIndex((e) => e.name === entry.name);
    if (existing >= 0) {
      if (memoryRankings[existing].totalAssets < totalAssets) {
        memoryRankings[existing] = entry;
      }
    } else {
      memoryRankings.push(entry);
    }
    memoryRankings.sort((a, b) => b.totalAssets - a.totalAssets);
    if (memoryRankings.length > MAX_RANKINGS) {
      memoryRankings = memoryRankings.slice(0, MAX_RANKINGS);
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
