// Capacitorネイティブアプリでは相対パスが `capacitor://` スキームになり
// 自前のAPIを叩けない。NEXT_PUBLIC_API_BASE_URL が設定されていればそれを前置し、
// Webビルド時は従来通り同一オリジンの相対パスを返す。
export function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (base && path.startsWith("/")) {
    return `${base.replace(/\/$/, "")}${path}`;
  }
  return path;
}
