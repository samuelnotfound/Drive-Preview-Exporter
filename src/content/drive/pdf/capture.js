(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const IMAGE_SELECTOR = 'img[src^="blob:"], canvas';
    const imageWidth = element => element.naturalWidth ?? element.width ?? 0;
    const imageHeight = element => element.naturalHeight ?? element.height ?? 0;
    const MIN_WIDTH = 500;
    const MIN_HEIGHT = 300;
    const WAIT_FOR_VIEWER = 12000;
    const WAIT_FOR_IMAGE = 6000;
    const RING_CIRCUMFERENCE = 2 * Math.PI * 17;
    const CAPTURE_PROGRESS_PERCENT = 90;

    pdf.runId ??= 0;
    pdf.cancelOverlayTimer ??= null;

    function currentDocumentKey() {
        const fileId = location.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || '';
        const filename = app.isClassroomViewer?.() ? String(pdf.currentExportFilename || '').trim() : '';
        return [location.hostname, fileId || location.pathname, filename].join('|');
    }

    function pageFingerprint(page) {
        return [...page.querySelectorAll(IMAGE_SELECTOR)].map(image => {
            if (image.tagName === 'IMG') return image.currentSrc || image.src || '';
            return `${image.width}x${image.height}`;
        }).join('|');
    }

    function syncDocumentContext() {
        const key = currentDocumentKey();
        if (pdf.pageDocumentKey && key !== pdf.pageDocumentKey) {
            // Keep the previous page elements only as a rejection set. The
            // previous JPEG bytes are cleared separately by resetCaptureState.
            pdf.stalePageElements = new Map(
                [...(pdf.activePageElements || [])].map(page => [page, pageFingerprint(page)])
            );
        }
        if (key !== pdf.pageDocumentKey) pdf.pageDocumentKey = key;
        return key;
    }

    const report = (status, detail, percent = null) =>
        app.ui.updateInPageOverlay(status, detail, percent);

    const isCurrentRun = runId => runId === pdf.runId && !pdf.stopRequested;

    function resetProgressUI() {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        const ring = root.querySelector('#psd-inpage-ring');
        if (ring) {
            ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
            ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
        }
        root.classList.remove('cancelled', 'completed', 'unsupported');
    }

    function showUnsupportedFile() {
        clearTimeout(pdf.unsupportedTimer);
        pdf.status = 'idle';
        app.ui.updateWindowControl();
        app.ui.showInPageOverlay(true);

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('unsupported');
        root.querySelector('#psd-inpage-title')?.replaceChildren(
            document.createTextNode('File type not supported')
        );
        root.querySelector('#psd-inpage-detail')?.replaceChildren();
        root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'none');
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');

        pdf.unsupportedTimer = setTimeout(() => app.ui.showInPageOverlay(false), 2000);
    }

    // Classroom may keep the previous PDF in the DOM. Only use visibility
    // to *rank* page groups: Google can render the current preview in a
    // transitioning or virtualized container whose visibility is misleading.
    function visibilityScore(element) {
        if (!element?.isConnected) return 0;
        let score = 2;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return 0;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return 0;
            if (style.opacity === '0') score = Math.min(score, 1);
        }
        return score;
    }

    function sameClassSet(a, b) {
        if (a.tagName !== b.tagName || a.classList.length !== b.classList.length) return false;
        return [...a.classList].every(name => b.classList.contains(name));
    }

    function getPages() {
        syncDocumentContext();
        const groups = new Map();
        for (const image of document.querySelectorAll(IMAGE_SELECTOR)) {
            if (imageWidth(image) < MIN_WIDTH || imageHeight(image) < MIN_HEIGHT) continue;
            const page = image.parentElement;
            const container = page?.parentElement;
            if (!container || groups.has(container)) continue;
            const pages = [...container.children].filter(candidate => sameClassSet(page, candidate));
            if (!pages.length) continue;
            groups.set(container, {
                pages,
                score: visibilityScore(image),
                order: groups.size
            });
        }
        // Prefer the latest fully visible viewer. If Google reports every
        // page hidden during a transition, use the latest rendered group
        // rather than treating a displayed document as unavailable.
        const ranked = [...groups.values()].sort((a, b) =>
            b.score - a.score || b.order - a.order);
        if (!ranked.length) throw new Error('Could not find rendered document pages');
        const stale = pdf.stalePageElements;
        const fresh = stale?.size
            ? ranked.map(group => ({
                ...group,
                pages: group.pages.filter(page =>
                    !stale.has(page) || stale.get(page) !== pageFingerprint(page))
            })).filter(group => group.pages.length)
            : ranked;
        if (!fresh.length) throw new Error('Waiting for the current document pages');
        if (stale?.size) pdf.stalePageElements = null;
        return fresh[0].pages;
    }

    function getFirstPageImage() {
        try { return getPages().map(getPageImage).find(Boolean) || null; }
        catch (_) { return null; }
    }

    function getPageImage(page) {
        return [...page.querySelectorAll(IMAGE_SELECTOR)].find(img =>
            (img.tagName === 'CANVAS' || img.complete) && imageWidth(img) >= MIN_WIDTH && imageHeight(img) >= MIN_HEIGHT
        ) || null;
    }

    /** Wait for a rendered page while respecting cancellation and timeouts. */
    function waitForImage(findImage, observeRoot, timeoutMs, errorMessage, runId, pollMs = 100) {
        const image = findImage();
        if (image) return Promise.resolve(image);

        return new Promise((resolve, reject) => {
            let finished = false;
            const stop = (error, image) => {
                if (finished) return;
                finished = true;
                observer.disconnect();
                clearInterval(poll);
                clearTimeout(timeout);
                error ? reject(error) : resolve(image);
            };
            const check = () => {
                if (!isCurrentRun(runId)) return stop(new Error('Capture cancelled.'));
                const ready = findImage();
                if (ready) stop(null, ready);
            };
            const observer = new MutationObserver(check);
            const poll = setInterval(check, pollMs);
            const timeout = setTimeout(() => stop(new Error(errorMessage)), timeoutMs);
            observer.observe(observeRoot, { childList: true, attributes: true, subtree: true });
            check();
        });
    }

    function waitForPageImage(page, runId) {
        const ready = getPageImage(page);
        if (ready) return Promise.resolve(ready);
        page.scrollIntoView({ block: 'center' });
        return waitForImage(() => getPageImage(page), page, WAIT_FOR_IMAGE,
            'Timed out waiting for page image', runId);
    }

    function waitForFirstPage(runId) {
        return waitForImage(getFirstPageImage, document.body, WAIT_FOR_VIEWER,
            'Could not find rendered document pages', runId, 150);
    }

    async function imageToJPEG(image, runId) {
        if (!isCurrentRun(runId)) throw new Error('Capture cancelled.');

        const width = imageWidth(image);
        const height = imageHeight(image);
        if ((image.tagName !== 'CANVAS' && !image.complete) || width < MIN_WIDTH || height < MIN_HEIGHT) {
            throw new Error('A PDF page image is not ready.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        try {
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) throw new Error('Could not create PDF canvas.');

            context.drawImage(image, 0, 0, width, height);

            const blob = await new Promise((resolve, reject) =>
                canvas.toBlob(value => {
                    if (value) resolve(value);
                    else reject(new Error('JPEG encoding failed.'));
                }, 'image/jpeg', 0.92)
            );

            if (!isCurrentRun(runId)) throw new Error('Capture cancelled.');

            return {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                width,
                height
            };
        } finally {
            canvas.width = canvas.height = 1;
        }
    }

    async function capturePages(pages, runId) {
        for (let index = 0; index < pages.length; index++) {
            if (!isCurrentRun(runId)) return false;

            const pageNumber = index + 1;
            report(
                'Capturing',
                `Capturing page ${pageNumber} / ${pages.length}`,
                (index / pages.length) * CAPTURE_PROGRESS_PERCENT
            );

            try {
                if (getPages()[index] !== pages[index]) throw new Error('The open document changed. Please export it again.');
                const image = await waitForPageImage(pages[index], runId);
                const jpeg = await imageToJPEG(image, runId);
                if (getPages()[index] !== pages[index]) throw new Error('The open document changed. Please export it again.');
                pdf.capturedPages.set(pageNumber, jpeg);
                report('Capturing', `Captured page ${pageNumber} / ${pages.length}`,
                    (pageNumber / pages.length) * CAPTURE_PROGRESS_PERCENT);
            } catch (error) {
                if (!isCurrentRun(runId)) return false;

                report(
                    'Capture incomplete',
                    `Could not capture page ${pageNumber} / ${pages.length}`,
                    (index / pages.length) * CAPTURE_PROGRESS_PERCENT
                );
                console.warn('[Drive Media Saver] PDF page capture failed:', error);
                return false;
            }
        }

        report('Capturing', `Captured ${pages.length} pages`, CAPTURE_PROGRESS_PERCENT);
        return true;
    }

    function finishCancelledCapture() {
        clearTimeout(pdf.cancelOverlayTimer);
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        app.ui.updateWindowControl();

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('cancelled');
        root.querySelector('#psd-inpage-title').textContent = 'Export cancelled';
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
        pdf.cancelOverlayTimer = setTimeout(() => {
            if (pdf.status === 'cancelled') app.ui.showInPageOverlay(false);
        }, 800);
    }

    function resetForNewExport() {
        // A second attachment can open without navigating the Classroom tab.
        // Invalidate the previous job so it cannot finish and save old bytes.
        pdf.stopRequested = true;
        pdf.runId = (pdf.runId || 0) + 1;
        pdf.status = 'idle';
        resetCaptureState();
        clearTimeout(pdf.cancelOverlayTimer);
        clearTimeout(pdf.unsupportedTimer);
        app.ui.showScrollDim(false);
    }

    function beginCapture() {
        clearTimeout(pdf.cancelOverlayTimer);
        clearTimeout(pdf.unsupportedTimer);
        // Invalidate any previous capture before reading the current viewer.
        resetCaptureState();
        const runId = ++pdf.runId;
        pdf.status = 'capturing';
        pdf.stopRequested = false;
        resetProgressUI();

        const root = document.getElementById('psd-inpage-overlay');
        if (root) {
            root.classList.remove('minimized', 'cancelled', 'completed', 'unsupported');
            root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'flex');
            root.querySelector('#psd-inpage-toggle')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-check')?.style.setProperty('display', 'none');
        }

        app.ui.updateWindowControl();
        app.ui.showScrollDim(true);
        report('Preparing…', 'Waiting for pages to load…', 0);
        return runId;
    }

    function resetCaptureState() {
        pdf.capturedPages.clear();
    }

    async function prepare() {
        if (pdf.status === 'capturing' || pdf.status === 'processing' || !app.isDocumentViewer()) return;
        if (!app.pdf?.isPageDocumentPreview?.()) {
            showUnsupportedFile();
            return;
        }

        const runId = beginCapture();

        try {
            await waitForFirstPage(runId);
            if (!isCurrentRun(runId)) return;

            const pages = getPages();
            if (!pages.length) throw new Error('Could not find rendered pages');
            pdf.activePageElements = new Set(pages);

            report('Preparing…', `Found ${pages.length} page${pages.length === 1 ? '' : 's'}`, 0);
            const captured = await capturePages(pages, runId);

            if (!isCurrentRun(runId)) return;
            if (!captured || pdf.capturedPages.size !== pages.length) return;

            app.ui.showScrollDim(false);
            pdf.status = 'ready';
            app.ui.updateWindowControl();
            await app.pdfWriter.generate(runId);
        } catch (error) {
            if (!isCurrentRun(runId)) return;

            app.ui.showScrollDim(false);
            pdf.status = 'idle';
            app.ui.updateWindowControl();
            report('Capture incomplete', error.message || 'Could not capture the PDF.', 0);
            console.warn('[Drive Media Saver] PDF capture failed:', error);
        }
    }

    app.pdfCapture = {
        prepare,
        resetForNewExport,
        hasRenderedPages: () => {
            try { return getPages().length > 0; } catch (_) { return false; }
        },
        resetProgressUI,
        captureProgressPercent: CAPTURE_PROGRESS_PERCENT,
        resetCaptureState,
        finishCancelledCapture,
        getOrderedCapturedPages: () =>
            [...pdf.capturedPages.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, page]) => page)
    };
})();
