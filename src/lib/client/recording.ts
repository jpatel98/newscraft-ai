export async function startAudioRecording(
	signal: AbortSignal,
	onStopped: (audio: Blob | null) => void
): Promise<{ finish: () => void }> {
	if (signal.aborted) throw new DOMException('Recording cancelled', 'AbortError');
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	const stopTracks = () => stream.getTracks().forEach(track => track.stop());
	if (signal.aborted) {
		stopTracks();
		throw new DOMException('Recording cancelled', 'AbortError');
	}
	let recorder: MediaRecorder | null = null;
	let submitted = false;
	let released = false;
	const chunks: Blob[] = [];
	const release = () => {
		if (released) return;
		released = true;
		signal.removeEventListener('abort', cancel);
		try {
			if (recorder) {
				recorder.ondataavailable = null;
				recorder.onstop = null;
				recorder.onerror = null;
				if (recorder.state !== 'inactive') recorder.stop();
			}
		} catch {
		} finally {
			stopTracks();
		}
	};
	const cancel = () => release();
	try {
		const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
			.find(type => MediaRecorder.isTypeSupported?.(type));
		recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
		recorder.ondataavailable = event => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			const audio = new Blob(chunks, { type: (recorder?.mimeType || mimeType || 'audio/webm').split(';', 1)[0] });
			release();
			if (!signal.aborted) onStopped(submitted && audio.size > 0 ? audio : null);
		};
		recorder.onerror = () => {
			release();
			if (!signal.aborted) onStopped(null);
		};
		signal.addEventListener('abort', cancel, { once: true });
		recorder.start(1000);
		return {
			finish: () => {
				if (released || signal.aborted || !recorder || recorder.state === 'inactive') return;
				submitted = true;
				try {
					recorder.stop();
				} catch {
					release();
					if (!signal.aborted) onStopped(null);
				}
			}
		};
	} catch (error) {
		release();
		throw error;
	}
}
