import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, availableMonitors, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { VideoMixerState, VideoTrackSource } from "@/lib/video";

/**
 * Picture in picture: one small always-on-top window per video, so a share or a camera
 * stays in view over other apps. Browser picture in picture needs a <video>, and Raven's
 * frames are MJPEG in an <img>. The window reads the same engine state and the same
 * loopback stream as the stage; a second viewer costs no extra capture or JPEG encode.
 */

export type PipSource = "camera" | "screen";

/** Which video a window shows. `participantId` is null for your own camera. */
export interface PipTarget {
  participantId: string | null;
  source: PipSource;
}

/** The fields of a stage tile that picture in picture needs. */
export interface PipTile {
  participantId: string;
  isLocal: boolean;
  source: VideoTrackSource;
  cameraEnabled: boolean;
  receiving: boolean;
}

export type PipStatus = "live" | "reconnecting" | "gone";
export interface PipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PipSize {
  width: number;
  height: number;
}

/** Sent to the main window when "Back to the call" is clicked on a window. */
const PIP_RETURN_EVENT = "pip-return";
const LABEL_PREFIX = "pip-";
/** The share picker's filter in `video/capture.rs` looks for this title. */
const WINDOW_TITLE = "Raven picture in picture";
const SELF_SEGMENT = "self";
const CASCADE = 24;
const EDGE_MARGIN = 16;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 135;
/** A pixel or two off is rounding; correcting it would chase its own resize. */
const SHAPE_TOLERANCE = 2;
const DEFAULT_SIZE: Record<PipSource, { width: number; height: number }> = {
  camera: { width: 320, height: 180 },
  screen: { width: 400, height: 225 },
};

export const SELF_CAMERA_PIP: PipTarget = { participantId: null, source: "camera" };

export function pipKey(target: PipTarget) {
  return `${target.participantId ?? SELF_SEGMENT}:${target.source}`;
}

function pipLabel(target: PipTarget) {
  return `${LABEL_PREFIX}${pipKey(target).replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/** The local participant's id changes during a join, so your own camera is addressed by role. */
export function pipTargetForTile(tile: Pick<PipTile, "participantId" | "isLocal" | "source">): PipTarget {
  const source: PipSource = tile.source === "screenshare" ? "screen" : "camera";
  return { participantId: tile.isLocal ? null : tile.participantId, source };
}

export function pipRoutePath(target: PipTarget) {
  const person = target.participantId === null ? SELF_SEGMENT : encodeURIComponent(target.participantId);
  return `/#/pip/${person}/${target.source}`;
}

/** The target in a route's segments, or null if they do not name one. */
export function parsePipSegments(person: string | undefined, source: string | undefined): PipTarget | null {
  if (!person || (source !== "camera" && source !== "screen")) return null;
  if (person === SELF_SEGMENT) return source === "camera" ? SELF_CAMERA_PIP : null;
  return { participantId: decodeURIComponent(person), source };
}

export function findPipTile<T extends PipTile>(tiles: readonly T[], target: PipTarget): T | undefined {
  const source: VideoTrackSource = target.source === "screen" ? "screenshare" : "camera";
  return tiles.find((tile) =>
    tile.source === source && (target.participantId === null ? tile.isLocal : tile.participantId === target.participantId && !tile.isLocal),
  );
}

/**
 * `gone` means there is nothing left to show: the share ended, the camera went off, or
 * you stopped watching. A lost connection is not that, since the app is rejoining.
 */
export function pipStatus(state: Pick<VideoMixerState, "viewerConnected"> | null, tile: PipTile | undefined): PipStatus {
  if (!state?.viewerConnected) return "reconnecting";
  if (!tile || !tile.receiving) return "gone";
  if (tile.source === "camera" && !tile.cameraEnabled) return "gone";
  return "live";
}

function contains(area: PipRect, x: number, y: number) {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

/**
 * Where a new window goes, in physical pixels. It returns to where the last one of its
 * kind was, if that spot is still on a screen, stepping up and left per window already
 * open so none lands exactly on another. Otherwise it stacks up from the corner of
 * `fallbackArea`, one default share's height per window, so a camera never hides a share.
 */
export function pipRect({
  remembered,
  areas,
  fallbackArea,
  scale,
  source,
  openCount,
}: {
  remembered: PipRect | null;
  areas: readonly PipRect[];
  fallbackArea: PipRect;
  scale: number;
  source: PipSource;
  openCount: number;
}): PipRect {
  const width = remembered?.width ?? Math.round(DEFAULT_SIZE[source].width * scale);
  const height = remembered?.height ?? Math.round(DEFAULT_SIZE[source].height * scale);
  const home = remembered && areas.find((area) => contains(area, remembered.x + remembered.width / 2, remembered.y + remembered.height / 2));
  const area = home || fallbackArea;
  const fitted = { width: Math.min(width, area.width), height: Math.min(height, area.height) };
  const margin = Math.round(EDGE_MARGIN * scale);
  const cascade = Math.round(CASCADE * scale) * openCount;
  const stack = (Math.round(DEFAULT_SIZE.screen.height * scale) + margin) * openCount;
  const start = home && remembered
    ? { x: remembered.x - cascade, y: remembered.y - cascade }
    : { x: area.x + area.width - fitted.width - margin, y: area.y + area.height - fitted.height - margin - stack };
  return {
    ...fitted,
    x: Math.min(Math.max(start.x, area.x), area.x + area.width - fitted.width),
    y: Math.min(Math.max(start.y, area.y), area.y + area.height - fitted.height),
  };
}

/**
 * The size that gives `size` the picture's shape, or null if it already has it. A landscape
 * picture keeps the width, a portrait one the height, and neither goes under the minimum.
 */
export function pipShapedSize(size: PipSize, aspect: number, scale: number): PipSize | null {
  const shaped = aspect >= 1
    ? { width: size.width, height: size.width / aspect }
    : { width: size.height * aspect, height: size.height };
  const grow = Math.max(1, (MIN_WIDTH * scale) / shaped.width, (MIN_HEIGHT * scale) / shaped.height);
  const next = { width: Math.round(shaped.width * grow), height: Math.round(shaped.height * grow) };
  const close = Math.abs(next.width - size.width) <= SHAPE_TOLERANCE && Math.abs(next.height - size.height) <= SHAPE_TOLERANCE;
  return close ? null : next;
}

/** Keeps the calling window's shape during a resize where the platform allows it. */
export function lockPipAspect(aspect: number) {
  return invoke("window_lock_aspect", { aspect });
}

function rememberedRectKey(source: PipSource) {
  return `raven.pictureInPicture.${source}`;
}

export function readRememberedPipRect(source: PipSource): PipRect | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(rememberedRectKey(source)) ?? "null") as Partial<PipRect> | null;
    if (!parsed) return null;
    const { x, y, width, height } = parsed;
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
    return { x: x!, y: y!, width: width!, height: height! };
  } catch {
    return null;
  }
}

export function rememberPipRect(source: PipSource, rect: PipRect) {
  try {
    localStorage.setItem(rememberedRectKey(source), JSON.stringify(rect));
  } catch {
    // Remembering the spot is a convenience; the next window opens in the corner.
  }
}

/** Open a window for `target`. Rejects if it cannot be created. */
export async function openPipWindow(target: PipTarget, openCount: number): Promise<WebviewWindow> {
  const monitors = await availableMonitors();
  const toArea = (monitor: (typeof monitors)[number]): PipRect => ({
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  });
  const here = (await currentMonitor()) ?? monitors[0] ?? null;
  const scale = here?.scaleFactor ?? 1;
  const rect = pipRect({
    remembered: readRememberedPipRect(target.source),
    areas: monitors.map(toArea),
    fallbackArea: here ? toArea(here) : { x: 0, y: 0, width: 1280, height: 720 },
    scale,
    source: target.source,
    openCount,
  });

  // Never focusable, like the voice overlay: clicking it leaves the keyboard with the
  // game underneath. Hidden from capture, so a friend's camera cannot end up in your own
  // screen share and a shared display does not film itself.
  const webview = new WebviewWindow(pipLabel(target), {
    url: pipRoutePath(target),
    title: WINDOW_TITLE,
    x: rect.x / scale,
    y: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    decorations: false,
    resizable: true,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    shadow: true,
    focusable: false,
    focus: false,
    contentProtected: true,
  });
  await new Promise<void>((resolve, reject) => {
    void webview.once("tauri://created", () => resolve());
    void webview.once<string>("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
  // Logical numbers land off by the scale difference when screens have different scales.
  await webview.setPosition(new PhysicalPosition(rect.x, rect.y)).catch(() => undefined);
  await webview.setSize(new PhysicalSize(rect.width, rect.height)).catch(() => undefined);
  return webview;
}

/** Windows left behind by an earlier main page, or every window at the end of a call. */
export async function closeAllPipWindows() {
  const windows = await getAllWebviewWindows();
  await Promise.allSettled(windows.filter((window) => window.label.startsWith(LABEL_PREFIX)).map((window) => window.close()));
}

/** "Back to the call": raises Raven. The main window then shows the call. */
export async function returnToCall() {
  await invoke("window_show_main").catch(() => undefined);
  await emit(PIP_RETURN_EVENT);
}

export function subscribePipReturn(onReturn: () => void) {
  return listen(PIP_RETURN_EVENT, () => onReturn());
}
