// ネイティブ(Capacitor)向け静的ビルド
// - output: 'export' では POST を含む Route Handler がビルドエラーになるため
//   src/app/api を一時退避 → ビルド → 復帰 の手順で実行する
// - ランキングAPIはネイティブアプリから NEXT_PUBLIC_API_BASE_URL 経由で
//   デプロイ済みWeb版を叩く前提

import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const apiDir = resolve(root, "src/app/api");
const apiDirStash = resolve(root, "src/app/_api_stash_for_native_build");

function restore() {
  if (existsSync(apiDirStash)) {
    renameSync(apiDirStash, apiDir);
    console.log("[build-native] restored src/app/api");
  }
}

process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });

try {
  if (existsSync(apiDir)) {
    renameSync(apiDir, apiDirStash);
    console.log("[build-native] stashed src/app/api");
  }
  const result = spawnSync(
    "npx",
    ["--no-install", "next", "build"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, BUILD_TARGET: "native" },
    }
  );
  restore();
  process.exit(result.status ?? 1);
} catch (err) {
  restore();
  console.error(err);
  process.exit(1);
}
