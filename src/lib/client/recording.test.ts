import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAudioRecording } from './recording';

class Recorder {
	static isTypeSupported = () => true;
	static latest: Recorder;
	state = 'inactive';
	mimeType = 'audio/webm;codecs=opus';
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() { Recorder.latest = this; }
	start() { this.state = 'recording'; }
	stop() {
		this.state = 'inactive';
		this.ondataavailable?.({ data: new Blob(['recorded audio']) });
		this.onstop?.();
	}
}

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const stop = vi.fn();
	const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
	const acquire = vi.fn().mockResolvedValue(stream);
	vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: acquire } });
	vi.stubGlobal('MediaRecorder', Recorder);
	return { stop, stream, acquire };
}

describe('recording lifecycle', () => {
	it('releases a microphone permission result arriving after navigation', async () => {
		const { acquire, stream, stop } = setup();
		let accept!: (stream: MediaStream) => void;
		acquire.mockReturnValue(new Promise(resolve => { accept = resolve; }));
		const controller = new AbortController();
		const onStopped = vi.fn();
		const starting = startAudioRecording(controller.signal, onStopped);
		controller.abort();
		accept(stream);
		await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
		expect(stop).toHaveBeenCalledOnce();
		expect(onStopped).not.toHaveBeenCalled();
	});

	it('does not submit audio when navigation stops a running recorder', async () => {
		const { stop } = setup();
		const controller = new AbortController();
		const onStopped = vi.fn();
		await startAudioRecording(controller.signal, onStopped);
		controller.abort();
		expect(Recorder.latest.state).toBe('inactive');
		expect(stop).toHaveBeenCalledOnce();
		expect(onStopped).not.toHaveBeenCalled();
	});

	it('submits only an explicitly finished recording, once', async () => {
		const { stop } = setup();
		const onStopped = vi.fn();
		const recording = await startAudioRecording(new AbortController().signal, onStopped);
		recording.finish();
		recording.finish();
		expect(onStopped).toHaveBeenCalledOnce();
		expect(await (onStopped.mock.calls[0][0] as Blob).text()).toBe('recorded audio');
		expect(stop).toHaveBeenCalledOnce();
	});

	it('does not submit audio after an unexpected recorder stop', async () => {
		setup();
		const onStopped = vi.fn();
		await startAudioRecording(new AbortController().signal, onStopped);
		Recorder.latest.stop();
		expect(onStopped).toHaveBeenCalledExactlyOnceWith(null);
	});

	it('releases the microphone if recorder construction fails', async () => {
		const { stop } = setup();
		vi.stubGlobal('MediaRecorder', class {
			static isTypeSupported = () => true;
			constructor() { throw new Error('unsupported'); }
		});
		await expect(startAudioRecording(new AbortController().signal, vi.fn())).rejects.toThrow('unsupported');
		expect(stop).toHaveBeenCalledOnce();
	});

	it('releases tracks and reports failure when error cleanup cannot stop the recorder', async () => {
		const { stop } = setup();
		const onStopped = vi.fn();
		await startAudioRecording(new AbortController().signal, onStopped);
		vi.spyOn(Recorder.latest, 'stop').mockImplementation(() => {
			throw new DOMException('Recorder cannot stop', 'InvalidStateError');
		});
		expect(() => Recorder.latest.onerror?.()).not.toThrow();
		expect(stop).toHaveBeenCalledOnce();
		expect(onStopped).toHaveBeenCalledExactlyOnceWith(null);
	});

	it('preserves the startup error and releases tracks when cleanup also fails', async () => {
		const { stop } = setup();
		vi.stubGlobal('MediaRecorder', class extends Recorder {
			start() {
				super.start();
				throw new Error('Recording could not start');
			}
			stop() { throw new DOMException('Recorder cannot stop', 'InvalidStateError'); }
		});
		await expect(startAudioRecording(new AbortController().signal, vi.fn()))
			.rejects.toThrow('Recording could not start');
		expect(stop).toHaveBeenCalledOnce();
	});

	it('releases tracks and reports failure if an explicit finish cannot stop the recorder', async () => {
		const { stop } = setup();
		const onStopped = vi.fn();
		const recording = await startAudioRecording(new AbortController().signal, onStopped);
		vi.spyOn(Recorder.latest, 'stop').mockImplementation(() => {
			throw new DOMException('Recorder cannot stop', 'InvalidStateError');
		});
		expect(() => recording.finish()).not.toThrow();
		recording.finish();
		expect(stop).toHaveBeenCalledOnce();
		expect(onStopped).toHaveBeenCalledExactlyOnceWith(null);
	});
});
