import { BufferSource, Input, MP4, WEBM } from "mediabunny";
import {
  MAX_REVIEW_VIDEO_SECONDS,
  validateReviewVideoDurationBuffer,
  type AllowedReviewVideoMime,
} from "./validation.ts";

export async function validateStagedReviewVideo(
  bytes: Uint8Array,
  mime: AllowedReviewVideoMime
): Promise<ReturnType<typeof validateReviewVideoDurationBuffer>> {
  const declared = validateReviewVideoDurationBuffer(bytes, mime);
  if (!declared.ok) return declared;

  const input = new Input({ source: new BufferSource(bytes), formats: [mime === "video/mp4" ? MP4 : WEBM] });
  const invalid = { ok: false, error: "The video has an unreadable packet timeline." };
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || await video.getFirstTimestampOrNull() === null) return invalid;

    const [start, end] = await Promise.all([input.getFirstTimestamp(), input.computeDuration()]);
    const durationSeconds = end - Math.min(start, 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return invalid;
    if (durationSeconds > MAX_REVIEW_VIDEO_SECONDS) {
      return { ok: false, error: `Video must be ${MAX_REVIEW_VIDEO_SECONDS} seconds or shorter.` };
    }
    return { ok: true, durationSeconds };
  } catch {
    return invalid;
  } finally {
    input.dispose();
  }
}
