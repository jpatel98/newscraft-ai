export function isAllowedSignedStorageUrl(
	signedUrl: string,
	storageBaseUrl: string,
	allowLoopbackHttp: boolean
): boolean {
	try {
		const destination = new URL(signedUrl);
		const storage = new URL(storageBaseUrl);
		if (destination.origin !== storage.origin) return false;
		if (destination.protocol === 'https:') return true;
		return (
			allowLoopbackHttp &&
			destination.protocol === 'http:' &&
			['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)
		);
	} catch {
		return false;
	}
}
