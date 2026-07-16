export type HighRiskAction =
  | "publish_required"
  | "block_version"
  | "withdraw_release"
  | "disable_channel";

export function isHighRiskAction(value: string): value is HighRiskAction {
  return (
    value === "publish_required" ||
    value === "block_version" ||
    value === "withdraw_release" ||
    value === "disable_channel"
  );
}

export function normalizePercentage(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        return parsed as Record<string, unknown>;
    } catch {
      return { message: value };
    }
  }
  return {};
}
