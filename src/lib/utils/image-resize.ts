// Client-side image resize for vision attachments. Iteratively scales down +
// re-encodes a source image until it fits the per-image cap, returning a base64
// data URI ready to ship as an OpenAI multimodal `image_url` part.
//
// Per-image cap is set well under Hermes's 1 MB body cap so 1–2 images plus
// the text + history JSON envelope still slot under the gateway limit.

export const MAX_IMAGE_BYTES = 800 * 1024;
export const MAX_TOTAL_BYTES = 950 * 1024;

const SIZE_STEPS = [1600, 1200, 1024, 768];
const QUALITY_STEPS = [0.85, 0.75, 0.6];

export class ImageTooLargeError extends Error {
	constructor() {
		super("Image won't fit under 800 KB even after resizing.");
		this.name = 'ImageTooLargeError';
	}
}

export class UnsupportedImageError extends Error {
	constructor(mime: string) {
		super(`Unsupported file type: ${mime || 'unknown'}. Images only.`);
		this.name = 'UnsupportedImageError';
	}
}

async function loadBitmap(file: Blob): Promise<{
	source: ImageBitmap | HTMLImageElement;
	width: number;
	height: number;
	hasAlpha: boolean;
}> {
	if (typeof createImageBitmap === 'function') {
		const bmp = await createImageBitmap(file);
		// Detect alpha cheaply by sampling the corner pixels via a 1×1 canvas;
		// this is a heuristic, but cheap and good enough to pick JPEG vs PNG.
		const probe = document.createElement('canvas');
		probe.width = 1;
		probe.height = 1;
		const pctx = probe.getContext('2d', { willReadFrequently: true });
		let hasAlpha = false;
		if (pctx) {
			pctx.drawImage(bmp, 0, 0, 1, 1);
			const px = pctx.getImageData(0, 0, 1, 1).data;
			hasAlpha = px[3] < 255;
		}
		return { source: bmp, width: bmp.width, height: bmp.height, hasAlpha };
	}
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = () => reject(new Error('image decode failed'));
			i.src = url;
		});
		return { source: img, width: img.naturalWidth, height: img.naturalHeight, hasAlpha: false };
	} finally {
		URL.revokeObjectURL(url);
	}
}

function pickFormat(file: File, hasAlpha: boolean): 'image/jpeg' | 'image/png' {
	// Screenshots tend to ship as PNG and can stay PNG when they have transparency
	// or look palette-ish. For everything else (and PNGs without alpha) JPEG is
	// dramatically smaller, so we switch.
	if (file.type === 'image/png' && hasAlpha) return 'image/png';
	return 'image/jpeg';
}

function drawScaled(
	source: CanvasImageSource,
	srcW: number,
	srcH: number,
	maxLong: number
): HTMLCanvasElement {
	const long = Math.max(srcW, srcH);
	const scale = long > maxLong ? maxLong / long : 1;
	const w = Math.max(1, Math.round(srcW * scale));
	const h = Math.max(1, Math.round(srcH * scale));
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('canvas 2d unavailable');
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source, 0, 0, w, h);
	return canvas;
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	mime: string,
	quality?: number
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error('canvas encode failed'))),
			mime,
			quality
		);
	});
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result));
		r.onerror = () => reject(r.error ?? new Error('FileReader failed'));
		r.readAsDataURL(blob);
	});
}

export interface ResizedImage {
	dataUrl: string;
	bytes: number;
	width: number;
	height: number;
	mime: 'image/jpeg' | 'image/png';
}

export async function resizeImage(file: File): Promise<ResizedImage> {
	if (!file.type.startsWith('image/')) throw new UnsupportedImageError(file.type);

	const { source, width, height, hasAlpha } = await loadBitmap(file);
	const mime = pickFormat(file, hasAlpha);

	let best: { blob: Blob; canvas: HTMLCanvasElement } | null = null;

	for (const maxLong of SIZE_STEPS) {
		const canvas = drawScaled(source, width, height, maxLong);
		if (mime === 'image/jpeg') {
			for (const q of QUALITY_STEPS) {
				const blob = await canvasToBlob(canvas, mime, q);
				if (blob.size <= MAX_IMAGE_BYTES) {
					const url = await blobToDataUrl(blob);
					return {
						dataUrl: url,
						bytes: blob.size,
						width: canvas.width,
						height: canvas.height,
						mime
					};
				}
				if (!best || blob.size < best.blob.size) best = { blob, canvas };
			}
		} else {
			const blob = await canvasToBlob(canvas, mime);
			if (blob.size <= MAX_IMAGE_BYTES) {
				const url = await blobToDataUrl(blob);
				return {
					dataUrl: url,
					bytes: blob.size,
					width: canvas.width,
					height: canvas.height,
					mime
				};
			}
			if (!best || blob.size < best.blob.size) best = { blob, canvas };
		}
	}

	throw new ImageTooLargeError();
}
