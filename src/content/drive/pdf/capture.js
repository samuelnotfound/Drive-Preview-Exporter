(() => {
    const app = window.__PSD;
    const pdf = app.pdfState;

    const IMAGE_SELECTOR = 'img, canvas';
    const fingerprintCanvas = document.createElement('canvas');
    fingerprintCanvas.width = fingerprintCanvas.height = 48;
    const fingerprintContext = fingerprintCanvas.getContext('2d', { willReadFrequently: true });
    const imageWidth = element => element.naturalWidth || element.width || 0;
    const imageHeight = element => element.naturalHeight || element.height || 0;
    const isPageSurface = element => element.tagName === 'CANVAS' ||
        (element.tagName === 'IMG' && [element.currentSrc, element.src,
            element.getAttribute('data-src'), element.getAttribute('srcset')]
            .some(value => String(value || '').includes('blob:')));
    const MIN_WIDTH = 500;
    const MIN_HEIGHT = 300;
    const WAIT_FOR_VIEWER = 12000;
    const WAIT_FOR_IMAGE = 12000;
    const PAGE_CAPTURE_ATTEMPTS = 4;
    const RING_CIRCUMFERENCE = 2 * Math.PI * 17;
    const CAPTURE_PROGRESS_PERCENT = 90;

    // Classroom needs document-switch verification. A standalone Drive file
    // does not: use its original blob page slots rather than Classroom's
    // stale-preview heuristics.
    const usesClassicDriveCapture = () => app.isDrivePage?.() &&
        !app.isClassroomViewer?.() && app.classroomPreviewTab !== true;

    pdf.runId ??= 0;
    pdf.cancelOverlayTimer ??= null;

    if (!pdf.viewerNavigationListenerInstalled) {
        document.addEventListener('click', event => {
            if (!(app.isClassroomViewer?.() || app.classroomPreviewTab === true)) return;
            const control = event.target?.closest?.('button,[role="button"]');
            if (!control) return;
            const label = String(control.getAttribute('aria-label') || control.getAttribute('title') ||
                control.getAttribute('data-tooltip') || control.innerText || control.textContent || '')
                .replace(/\s+/g, ' ').trim().toLowerCase();
            const isAttachmentNavigation = /^(?:next|previous|prev|back|forward)(?:\s+(?:attachment|file|document|item))?$/.test(label) ||
                /^(?:>|›|❯)$/.test(label);
            if (isAttachmentNavigation && !/\bpage\b/.test(label)) {
                app.ui.dismissFinishedClassroomOverlay?.();
                pdf.viewerNavigationPending = true;
                pdf.pendingDocumentFingerprint = null;
                pdf.viewerNavigationFingerprints = pdf.lastObservedDocumentFingerprints ||
                    pdf.activeDocumentFingerprints || null;
                if (!pdf.viewerNavigationFingerprints?.length) {
                    try { pdf.viewerNavigationFingerprints = getPages().map(pageFingerprint); }
                    catch (_) { pdf.viewerNavigationFingerprints = null; }
                }
                void chrome.runtime.sendMessage({
                    action: 'classroomPreviewNavigation', pending: true,
                    ...(pdf.viewerNavigationFingerprints?.length
                        ? { fingerprints: pdf.viewerNavigationFingerprints } : {})
                }).catch(() => {});
            }
        }, true);
        pdf.viewerNavigationListenerInstalled = true;
    }

    function currentDocumentKey() {
        const fileId = location.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || '';
        const inClassroom = app.isClassroomViewer?.() || app.classroomPreviewTab === true;
        const filename = inClassroom ? String(pdf.currentExportFilename || '').trim() : '';
        return [location.hostname, fileId || location.pathname, filename].join('|');
    }

    function pageFingerprint(page) {
        const selected = getPageImage(page);
        if (!selected) return 'unresolved-page';
        return [selected].map(image => {
            const source = image.tagName === 'IMG' ? (image.currentSrc || image.src || '') : '';
            const width = imageWidth(image);
            const height = imageHeight(image);
            if (!fingerprintContext || !width || !height) return `${source}|${width}x${height}`;

            // A PDF renderer can reuse the same canvas element and dimensions
            // for another attachment. Sample its pixels so that reuse counts
            // as a document change only after the rendered page actually changes.
            let hash = 2166136261;
            try {
                fingerprintContext.clearRect(0, 0, 48, 48);
                fingerprintContext.drawImage(image, 0, 0, 48, 48);
                for (const channel of fingerprintContext.getImageData(0, 0, 48, 48).data) {
                    hash ^= channel;
                    hash = Math.imul(hash, 16777619);
                }
            } catch (_) {
                return `${source}|${width}x${height}`;
            }
            return `${source}|${width}x${height}:${hash >>> 0}`;
        }).join('|');
    }

    function pagesFingerprint(pages) {
        return `${pages.length}#${pages.map(pageFingerprint).join('##')}`;
    }

    function matchesPreviousDocument(pages, previousFingerprints) {
        if (!previousFingerprints?.length || !pages.length) return false;
        const previous = new Set(previousFingerprints);
        // Compare across all positions: Classroom can reorder or reuse old
        // pages. One retained image is enough to make a PDF unsafe to export.
        return pages.some(page => previous.has(pageFingerprint(page)));
    }

    function syncDocumentContext() {
        const key = currentDocumentKey();
        if (pdf.pageDocumentKey && key !== pdf.pageDocumentKey) {
            // Classroom may reuse the same frame and canvas nodes for the
            // next attachment. Remember the previous rendered document by
            // content, not element identity or canvas dimensions alone.
            // This snapshot is recorded when the previous export finishes.
            // Do not fingerprint the live canvases here: Classroom may have
            // already switched them to the next attachment before this probe.
            pdf.staleDocumentFingerprints = pdf.activeDocumentFingerprints || null;
            pdf.pendingDocumentFingerprint = null;
        }
        if (key !== pdf.pageDocumentKey) pdf.pageDocumentKey = key;
        return key;
    }

    const report = (status, detail, percent = null) => {
        app.ui.updateInPageOverlay(status, detail, percent);
        if (pdf.currentExportFilename || app.classroomPreviewTab || app.isClassroomViewer?.()) {
            void chrome.runtime.sendMessage({
                action: 'classroomExportProgress', status, detail, percent,
                filename: pdf.currentExportFilename || '',
                jobId: pdf.classroomJobId || ''
            }).catch(() => {});
        }
    };

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
        // Unsupported previews follow the same silent failure behavior.
        pdf.status = 'idle';
        app.ui.updateWindowControl();
        app.ui.failInPageOverlay('Unsupported file');
    }

    // Classroom may keep the previous PDF in the DOM. Only use visibility
    // to *rank* page groups: Google can render the current preview in a
    // transitioning or virtualized container whose visibility is misleading.
    function visibilityScore(element) {
        if (!element?.isConnected) return 0;
        let score = 2;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            const style = getComputedStyle(node);
            // inert / aria-hidden control input and accessibility; Classroom
            // can apply them to a visually painted preview inside a modal.
            // Do not discard actual image bytes because of those flags.
            if (node.inert || node.getAttribute('aria-hidden') === 'true')
                score = Math.min(score, 1);
            // Visibility from layout is useful for excluding retained previews.
            // Hidden attribute may be overridden by author CSS, so trust the
            // computed display value rather than the attribute alone.
            if (style.display === 'none' || style.visibility === 'hidden') return 0;
            if (style.opacity === '0') score = Math.min(score, 1);
        }
        return score;
    }

    function sameClassSet(a, b) {
        if (a.tagName !== b.tagName || a.classList.length !== b.classList.length) return false;
        return [...a.classList].every(name => b.classList.contains(name));
    }

    function getPages({ probe = false } = {}) {
        if (usesClassicDriveCapture()) {
            const image = [...document.querySelectorAll('img[src^="blob:"]')].find(img =>
                img.complete && img.naturalWidth >= MIN_WIDTH && img.naturalHeight >= MIN_HEIGHT);
            const page = image?.parentElement;
            const container = page?.parentElement;
            if (page && container) return [...container.children].filter(candidate =>
                sameClassSet(page, candidate));
            // Some newer Drive viewers render on canvas. Use the generic
            // detector only when the original blob-page layout is absent.
        }
        syncDocumentContext();
        const groups = new Map();
        for (const image of document.querySelectorAll(IMAGE_SELECTOR)) {
            if (!isPageSurface(image) || imageWidth(image) < MIN_WIDTH ||
                imageHeight(image) < MIN_HEIGHT) continue;
            const page = image.parentElement;
            const container = page?.parentElement;
            if (!container || groups.has(container)) continue;
            const pages = [...container.children].filter(candidate =>
                sameClassSet(page, candidate) && visibilityScore(candidate) > 0);
            // PDF viewers virtualize pages and load their images on demand.
            // A single rendered page is enough to identify its page container.
            // Capture will scroll to and wait for each remaining page image.
            if (!pages.length || !pages.some(candidate => !!getPageImage(candidate))) continue;
            groups.set(container, {
                pages,
                score: Math.min(...pages.map(visibilityScore)),
                order: groups.size
            });
        }
        // Prefer the latest fully visible viewer. If Google reports every
        // page hidden during a transition, use the latest rendered group
        // rather than treating a displayed document as unavailable.
        const ranked = [...groups.values()].sort((a, b) =>
            b.score - a.score || b.order - a.order);
        if (!ranked.length) throw new Error('Could not find rendered document pages');
        const staleFingerprints = Array.isArray(pdf.externalStaleFingerprints)
            ? pdf.externalStaleFingerprints
            : pdf.viewerNavigationPending && pdf.viewerNavigationFingerprints?.length
            ? pdf.viewerNavigationFingerprints
            : pdf.staleDocumentFingerprints?.length ? pdf.staleDocumentFingerprints
            : pdf.viewerNavigationPending ? pdf.activeDocumentFingerprints : null;
        if (probe) {
            // A Classroom tab may retain an older page renderer. Return a
            // completely new group when one is present, instead of probing
            // only the highest-ranked (often stale) renderer forever.
            if (staleFingerprints?.length) {
                const previous = new Set(staleFingerprints);
                const newGroup = ranked.find(group => {
                    const signatures = group.pages.map(pageFingerprint);
                    return signatures.some(value => value !== 'unresolved-page') &&
                        !signatures.some(value => previous.has(value));
                });
                if (newGroup) return newGroup.pages;
            }
            return ranked[0].pages;
        }
        if (!staleFingerprints?.length) {
            // If there are two equally visible previews, we cannot know which
            // is current. Never guess based on DOM insertion order.
            if (ranked.length > 1 && ranked[0].score === ranked[1].score &&
                pagesFingerprint(ranked[0].pages) !== pagesFingerprint(ranked[1].pages)) {
                throw new Error('Multiple document previews are present. Reopen the current PDF.');
            }
            if (!probe) {
                pdf.lastObservedDocumentFingerprints = ranked[0].pages.map(pageFingerprint);
                pdf.lastObservedDocumentKey = pdf.pageDocumentKey;
            }
            return ranked[0].pages;
        }

        const current = ranked.find(group => !matchesPreviousDocument(group.pages, staleFingerprints));
        if (!current) {
            pdf.pendingDocumentFingerprint = null;
            throw new Error('Waiting for the current document pages');
        }

        // A renderer can update canvases one at a time while changing
        // attachments. Require the complete page set and its pixels to stop
        // changing briefly before reporting it as the new document.
        const fingerprint = pagesFingerprint(current.pages);
        const now = Date.now();
        if (pdf.pendingDocumentFingerprint?.value !== fingerprint) {
            pdf.pendingDocumentFingerprint = { value: fingerprint, since: now };
            throw new Error('Waiting for the current document pages');
        }
        if (now - pdf.pendingDocumentFingerprint.since < 350) {
            throw new Error('Waiting for the current document pages');
        }

        if (!probe) {
            pdf.staleDocumentFingerprints = null;
            // Keep the verified signature during capture. Clearing it here
            // forces the *next* getPages() call to wait another 350ms, which
            // immediately aborts a valid PDF after the first page check.
            // New documents reset the signature in syncDocumentContext().
            pdf.viewerNavigationPending = false;
            pdf.viewerNavigationFingerprints = null;
            pdf.lastObservedDocumentFingerprints = current.pages.map(pageFingerprint);
            pdf.lastObservedDocumentKey = pdf.pageDocumentKey;
        }
        return current.pages;
    }

    function getFirstPageImage() {
        try { return getPages().map(getPageImage).find(Boolean) || null; }
        catch (_) { return null; }
    }

    function getPageImage(page) {
        if (usesClassicDriveCapture()) {
            const image = [...page.querySelectorAll('img[src^="blob:"]')].find(img =>
                img.complete && img.naturalWidth >= MIN_WIDTH && img.naturalHeight >= MIN_HEIGHT);
            if (image) return image;
        }
        const images = [...page.querySelectorAll(IMAGE_SELECTOR)].filter(image =>
            isPageSurface(image) && (image.tagName === 'CANVAS' || image.complete) &&
            imageWidth(image) >= MIN_WIDTH && imageHeight(image) >= MIN_HEIGHT &&
            visibilityScore(image) > 0);
        if (images.length === 1) return images[0];
        if (images.length > 1) {
            const highScore = Math.max(...images.map(visibilityScore));
            const visible = images.filter(image => visibilityScore(image) === highScore);
            if (visible.length === 1) return visible[0];
        }
        // More than one equally visible page image is ambiguous. Never
        // choose one randomly, because it might belong to a previous PDF.
        return null;
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

    // A page is identified by its own DOM slot, not by the most recently
    // loaded blob in the viewer. Google can temporarily reuse the preceding
    // page's blob URL while the next page is rendering.
    function blobSource(image) {
        if (image?.tagName !== 'IMG') return '';
        const source = image.currentSrc || image.src || '';
        return source.startsWith('blob:') ? source : '';
    }

    function waitForPageImage(page, runId, capturedSources = new Set()) {
        const findUniqueImage = () => {
            const image = getPageImage(page);
            return image && !capturedSources.has(blobSource(image)) ? image : null;
        };
        const ready = findUniqueImage();
        if (ready) return Promise.resolve(ready);
        page.scrollIntoView({ block: 'center' });
        return waitForImage(findUniqueImage, page, WAIT_FOR_IMAGE,
            'Timed out waiting for the correct page blob', runId);
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

    // Keep the viewer selected when capture began. Re-scanning every page's
    // fingerprints can reject a valid PDF simply because a lazy page redraws.
    // Page identity is checked at the moment it is encoded instead.
    function capturePageAt(pages, index, documentKey) {
        if (usesClassicDriveCapture()) {
            if (currentDocumentKey() !== documentKey || !pages[index]?.isConnected ||
                pages[index].parentElement !== pages[0]?.parentElement) {
                throw new Error('The Drive page list changed during capture.');
            }
            return pages[index];
        }
        if (currentDocumentKey() !== documentKey || pdf.viewerNavigationPending) {
            throw new Error('The open document changed. Please export it again.');
        }
        const container = pages[0]?.parentElement;
        if (!container?.isConnected) throw new Error('The PDF viewer was replaced.');
        // Classroom changes hover/selected classes as pages scroll. That is
        // not a new PDF. Keep the page nodes identified at capture start;
        // never refill missing slots from a different renderer.
        if (visibilityScore(container) === 0 || pages.some(page =>
            !page.isConnected || page.parentElement !== container)) {
            throw new Error('The PDF page list was replaced.');
        }
        return pages[index];
    }

    async function capturePages(pages, runId) {
        const documentKey = currentDocumentKey();
        const capturedBlobSources = new Set();
        const driveCapture = usesClassicDriveCapture();
        for (let index = 0; index < pages.length; index++) {
            if (!isCurrentRun(runId)) return false;
            const pageNumber = index + 1;
            report('Capturing', `Capturing page ${pageNumber} / ${pages.length}`,
                (index / pages.length) * CAPTURE_PROGRESS_PERCENT);

            let lastError;
            for (let attempt = 0; attempt < PAGE_CAPTURE_ATTEMPTS; attempt++) {
                if (!isCurrentRun(runId)) return false;
                try {
                    const page = capturePageAt(pages, index, documentKey);
                    const image = await waitForPageImage(page, runId,
                        driveCapture ? new Set() : capturedBlobSources);
                    if (!isCurrentRun(runId)) return false;
                    const before = pageFingerprint(page);
                    const jpeg = await imageToJPEG(image, runId);
                    if (!isCurrentRun(runId)) return false;
                    const current = capturePageAt(pages, index, documentKey);
                    // The image may redraw or be replaced while JPEG encoding
                    // runs. Retry this page rather than failing all pages.
                    if (current !== page || (!driveCapture && (getPageImage(page) !== image ||
                        pageFingerprint(page) !== before))) {
                        throw new Error('The PDF page changed while capturing.');
                    }
                    const source = blobSource(image);
                    if (!driveCapture && source && capturedBlobSources.has(source)) {
                        throw new Error('A previous page blob was reused.');
                    }
                    // Commit the page and its URL together. A placeholder
                    // repeating page N's blob at page N+1 must not enter PDF.
                    pdf.capturedPages.set(pageNumber, jpeg);
                    if (source) capturedBlobSources.add(source);
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error;
                    if (!isCurrentRun(runId)) return false;
                    // A new document or navigation is never safe to retry.
                    if (currentDocumentKey() !== documentKey || pdf.viewerNavigationPending) break;
                    if (attempt < PAGE_CAPTURE_ATTEMPTS - 1) {
                        // Allow Classroom to finish repainting this single page.
                        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
                    }
                }
            }
            if (lastError) {
                report('Capture incomplete',
                    `Could not capture page ${pageNumber} / ${pages.length}`,
                    (index / pages.length) * CAPTURE_PROGRESS_PERCENT);
                console.warn('[Drive Preview Exporter] PDF page capture failed:',
                    { page: pageNumber, attempts: PAGE_CAPTURE_ATTEMPTS, error: lastError });
                throw lastError;
            }
            report('Capturing', `Captured page ${pageNumber} / ${pages.length}`,
                (pageNumber / pages.length) * CAPTURE_PROGRESS_PERCENT);
        }
        report('Capturing', `Captured ${pages.length} pages`, CAPTURE_PROGRESS_PERCENT);
        return true;
    }

    function finishCancelledCapture() {
        clearTimeout(pdf.cancelOverlayTimer);
        app.ui.showScrollDim(false);
        pdf.status = 'cancelled';
        pdf.capturedPages.clear();
        app.ui.updateWindowControl();

        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;

        root.classList.add('cancelled');
        root.querySelector('#psd-inpage-title').textContent = 'Export cancelled';
        root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'none');
        report('Export cancelled', 'Export cancelled.', 0);
        // Cancel dismisses the local card immediately; don't keep an old
        // 'Waiting for the current preview' detail visible below it.
        root.querySelector('#psd-inpage-detail')?.replaceChildren();
        app.ui.showInPageOverlay(false);
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
        pdf.pendingDocumentFingerprint = null;
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
            if (!captured || pdf.capturedPages.size !== pages.length) {
                resetCaptureState();
                app.ui.showScrollDim(false);
                pdf.status = 'idle';
                app.ui.updateWindowControl();
                return;
            }
            pdf.activeDocumentFingerprints = pages.map(pageFingerprint);
            pdf.lastObservedDocumentFingerprints = pdf.activeDocumentFingerprints;
            pdf.lastObservedDocumentKey = pdf.pageDocumentKey;
            pdf.viewerNavigationPending = false;
            pdf.viewerNavigationFingerprints = null;

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
        diagnosePageSurfaces: () => {
            const candidates = [...document.querySelectorAll(IMAGE_SELECTOR)]
                .filter(isPageSurface);
            const sized = candidates.filter(image => imageWidth(image) >= MIN_WIDTH &&
                imageHeight(image) >= MIN_HEIGHT);
            let groups = 0;
            try { groups = getPages({ probe: true }).length; } catch (_) {}
            return { surfaces: candidates.length, largeSurfaces: sized.length,
                renderedPages: groups, host: location.hostname };
        },
        hasRenderedPages: () => {
            try { return getPages({ probe: true }).length > 0; } catch (_) { return false; }
        },
        probePageFingerprints: () => {
            try { return getPages({ probe: true }).map(pageFingerprint); }
            catch (_) { return []; }
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
