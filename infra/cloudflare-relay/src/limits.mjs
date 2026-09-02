export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const RESPONSE_START_TIMEOUT_MS = 120_000;
export const REQUEST_FRAME_OVERHEAD_BYTES = 256 * 1024;
export const MAX_BRIDGE_MESSAGE_BYTES = 6 * 1024 * 1024;

export function minimumRequestFrameBytes(bodyBytes) {
  const bytes = Number(bodyBytes);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("bodyBytes must be a non-negative number");
  return Math.ceil(bytes / 3) * 4 + REQUEST_FRAME_OVERHEAD_BYTES;
}
