(() => {
    const app = window.__PSD;
    if (!app || window.__DPE_DRIVE_AUTO_EXPORT) return;
    window.__DPE_DRIVE_AUTO_EXPORT = true;

    async function startPendingExport() {
        if (!app.isDrivePage()) return;
        let result;
        try { result = await chrome.runtime.sendMessage({ action: 'consumeGoogleDocExport' }); }
        catch (_) { return; }
        if (!result?.success) return;

        app.ui.showInPageOverlay(true);
        app.ui.updateInPageOverlay('Preparing export', 'Waiting for document pages…', 0);

        // Drive's viewer may load after the content script. Only start when real
        // page images appear; native Docs redirects may never offer them.
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (app.pdfCapture?.hasRenderedPages?.()) {
                const handoff = await chrome.runtime.sendMessage({ action: 'finishGoogleDocExport' });
                if (handoff?.success) await app.pdf?.start?.();
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        app.ui.updateInPageOverlay('Capture incomplete', 'Drive did not expose rendered document pages.', 0);
        const root = document.getElementById('psd-inpage-overlay');
        root?.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Document preview unavailable'));
        const actions = root?.querySelector('#psd-inpage-actions');
        if (actions) actions.style.display = 'none';
        const close = root?.querySelector('#psd-inpage-close');
        if (close) close.style.display = 'block';
    }

    app.startPendingDocsExport = startPendingExport;
})();
