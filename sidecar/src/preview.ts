/** The CSP precedes untrusted markup. The iframe also needs sandbox=allow-scripts. */
export function previewDocument(html: string, runtime: string): string {
	const policy =
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html.replace('<script src="/_ryu/runtime.js"></script>', `<script>${runtime.replace(/<\/script/gi, "<\\/script")}</script>`)}`;
}
