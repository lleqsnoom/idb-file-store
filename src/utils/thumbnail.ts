import { NotSupportedError } from '../errors.js';

/**
 * Preview generation for images.
 *
 * Everything here is best-effort: in a worker, in Node, or on a browser without
 * `createImageBitmap`, the helpers return `null` and the caller simply stores no
 * thumbnail. Nothing else in the library depends on a thumbnail existing.
 */

/** A generated preview and the intrinsic size of the source image. */
export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

/** Intrinsic pixel size of an image, when the runtime can decode it. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Options for {@link generateThumbnail}. */
export interface ThumbnailOptions {
  /** Longest edge of the generated preview, in pixels. Defaults to 256. */
  maxSize?: number;
  /** Preferred output type. Defaults to `image/webp`, falling back to `image/png`. */
  type?: string;
  /** Encoder quality for lossy formats, 0 to 1. Defaults to 0.82. */
  quality?: number;
}

/** Longest edge of a generated preview when the caller does not pick one. */
export const DEFAULT_THUMBNAIL_SIZE = 256;

/** `true` when the runtime can decode images into bitmaps. */
export function supportsImageDecoding(): boolean {
  return typeof globalThis.createImageBitmap === 'function';
}

/** Decodes a blob into an `ImageBitmap`-like object, or returns `null`. */
async function decode(
  blob: Blob,
): Promise<{ bitmap: ImageBitmap; width: number; height: number } | null> {
  if (!supportsImageDecoding()) return null;
  try {
    const bitmap = await globalThis.createImageBitmap(blob);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    return null;
  }
}

/** Reads the intrinsic pixel size of an image, or `null` when undecodable. */
export async function readImageDimensions(blob: Blob): Promise<ImageDimensions | null> {
  const decoded = await decode(blob);
  if (!decoded) return null;
  const { width, height } = decoded;
  decoded.bitmap.close();
  return { width, height };
}

/** Scales `width`/`height` down so the longest edge equals `maxSize`. */
export function fitWithin(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSize || longest === 0) return { width, height };
  const ratio = maxSize / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** Generates a preview image for `blob`, or `null` when unsupported. */
export async function generateThumbnail(
  blob: Blob,
  options: ThumbnailOptions = {},
): Promise<ThumbnailResult | null> {
  if (blob.size === 0) return null;
  const decoded = await decode(blob);
  if (!decoded) return null;

  const maxSize = Math.max(16, Math.floor(options.maxSize ?? DEFAULT_THUMBNAIL_SIZE));
  const target = fitWithin(decoded.width, decoded.height, maxSize);
  const type = options.type ?? 'image/webp';
  const quality = clamp01(options.quality ?? 0.82);

  try {
    const canvas = createCanvas(target.width, target.height);
    const context = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!context) return null;
    context.drawImage(decoded.bitmap, 0, 0, target.width, target.height);
    const encoded = await encodeCanvas(canvas, type, quality);
    if (!encoded) return null;
    return {
      blob: encoded,
      width: target.width,
      height: target.height,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
    };
  } catch {
    return null;
  } finally {
    decoded.bitmap.close();
  }
}

/** Creates an offscreen canvas when possible, otherwise a detached DOM one. */
function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const documentScope = (globalThis as { document?: Document }).document;
  if (!documentScope) {
    throw new NotSupportedError('No canvas implementation is available for thumbnail generation');
  }
  const canvas = documentScope.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    try {
      return await canvas.convertToBlob({ type, quality });
    } catch {
      return await canvas.convertToBlob({ type: 'image/png' }).catch(() => null);
    }
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.82;
  return Math.min(1, Math.max(0, value));
}