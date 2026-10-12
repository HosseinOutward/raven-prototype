export type StageTileCandidate = {
  key: string;
  source: "camera" | "screenshare";
  speaking: boolean;
  streamUrl?: string;
  shareStartedAt?: number;
};

export function newestScreenShareKey(tiles: StageTileCandidate[]) {
  return tiles
    .filter((tile) => tile.source === "screenshare")
    .sort((left, right) => (right.shareStartedAt ?? 0) - (left.shareStartedAt ?? 0))[0]?.key ?? null;
}

export function resolveStageFocusKey({
  tiles,
  manualPinKey,
  followScreenShares,
  focusMode,
}: {
  tiles: StageTileCandidate[];
  manualPinKey: string | null;
  followScreenShares: boolean;
  focusMode: boolean;
}) {
  if (manualPinKey && tiles.some((tile) => tile.key === manualPinKey)) return manualPinKey;
  if (followScreenShares) {
    const shareKey = newestScreenShareKey(tiles);
    if (shareKey) return shareKey;
  }
  if (!focusMode) return null;
  return tiles.find((tile) => tile.speaking && tile.streamUrl)?.key ?? tiles.find((tile) => tile.streamUrl)?.key ?? tiles[0]?.key ?? null;
}

export function bestGridColumns(count: number, width: number, height: number) {
  if (count <= 1) return 1;
  let best = 1;
  let bestScore = Number.NEGATIVE_INFINITY;
  const maxColumns = Math.min(count, width < 640 ? 2 : 5);
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = Math.max(1, width - (columns - 1) * 8) / columns;
    const tileHeight = Math.max(1, height - (rows - 1) * 8) / rows;
    const usableArea = Math.min(tileWidth * tileHeight, tileHeight * tileHeight * (16 / 9));
    const emptyCells = rows * columns - count;
    const shapePenalty = Math.abs(tileWidth / tileHeight - 16 / 9) * usableArea * 0.08;
    const score = usableArea - shapePenalty - emptyCells * usableArea * 0.12;
    if (score > bestScore) {
      best = columns;
      bestScore = score;
    }
  }
  return best;
}

export type StageTileMedia = {
  source: "camera" | "screenshare";
  cameraEnabled: boolean;
  streamUrl?: string;
  loading?: boolean;
  mediaError?: string;
};

/** A tile earns stage space only when it has, or is about to have, something to look at. */
export function isVisualTile(tile: StageTileMedia) {
  return tile.source === "screenshare" || tile.cameraEnabled || Boolean(tile.streamUrl) || Boolean(tile.loading) || Boolean(tile.mediaError);
}

/**
 * Split participants into those shown as video tiles and those present by voice
 * only, keeping order. A voice-first room with nobody on camera has no tiles at all.
 */
export function partitionStageTiles<T extends StageTileMedia>(tiles: T[]) {
  const visual: T[] = [];
  const voice: T[] = [];
  for (const tile of tiles) (isVisualTile(tile) ? visual : voice).push(tile);
  return { visual, voice };
}
