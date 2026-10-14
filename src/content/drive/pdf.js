
(() => {
    if (!window.__PSD_LOADED || window.__PSD_PDF_LOADED) return;
    window.__PSD_PDF_LOADED = true;

    const app = window.__PSD;
    const pdf = app.pdfState;
    const MENU_ID = app.ids.pdfMenu;

    const DOCUMENT_EXTENSION = /\.(?:pdf|docx?|odt|rtf|pptx?)(?:$|[?#])/i;
    const DOCUMENT_MIME = /^(?:application\/pdf|application\/msword|application\/rtf|application\/vnd\.(?:google-apps\.(?:document|presentation)|openxmlformats-officedocument\.(?:wordprocessingml|presentationml)\.|oasis\.opendocument\.(?:text|presentation)))/i;

    // Find the Print command itself. Do not require the rest of Google's
    // menu to have exact text, order, role, or aria labels. Those details
    // change between Classroom attachment viewer versions.
    function classroomListActionName(row) {
        if (!row?.matches?.('li')) return '';
        const aria = String(row.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const visible = String(row.textContent || '').replace(/\s+/g, ' ').trim();
        // Use a label at the beginning of a single native list item, not text
        // scraped from an entire menu group. Print often includes Ctrl+P.
        for (const [name, pattern] of [
            ['Print', /^Print(?=\s|Ctrl\s*\+\s*P|$)/i],
            ['Details', /^Details(?=\s|D$|$)/i],
            ['Open', /^Open(?=\W|$)/i],
            ['Download', /^Download(?:\s|$)/i]
        ]) {
            if (pattern.test(aria) || pattern.test(visible)) return name;
        }
        return '';
    }

    function classroomMenuList(menu) {
        if (!menu) return null;
        const lists = menu.matches?.('ul') ? [menu] : [...menu.querySelectorAll('ul')];
        return lists.find(list => {
            const labels = [...list.children].map(classroomListActionName);
            return labels.includes('Print') &&
                (labels.includes('Details') || labels.includes('Open')) &&
                !labels.includes('Download');
        }) || null;
    }

    function isEmbeddedClassroomFileMenu(menu) {
        if (document.querySelector('video')) return false;
        const inClassroom = app.isClassroomViewer() || app.classroomPreviewTab === true;
        if (!inClassroom) return false;
        if (classroomMenuList(menu)) return true;
        // Retain the pre-v1.9.35 fallback for older div-based viewers.
        // This was the insertion path that worked in real Classroom sessions.
        const has = label => !!app.ui.findMenuRow(menu, label);
        return has('Print') && (has('Details') || has('Open')) && !has('Download');
    }

    function isPageDocumentPreview() {
        if (!app.isDocumentViewer()) return false;
        // Classroom and embedded Docs PDF viewers do not expose Drive file metadata.
        // Require actual capturable pages instead of guessing from the URL or filename.
        if (app.isClassroomViewer()) {
            if (document.querySelector('video')) return false;
            if (app.pdfCapture?.hasRenderedPages?.()) return true;
            // Classroom's File menu can be outside the iframe rendering the pages.
            return location.hostname === 'classroom.google.com' &&
                app.ui.getVisibleFileMenus().some(menu =>
                    ['Open', 'Details', 'Print'].every(label => app.ui.findMenuRow(menu, label)));
        }

        // Never insert the PDF capture option into a video or audio player.
        const info = document.querySelector('#drive-active-item-info');
        let metadata = {};
        if (info?.textContent) {
            try { metadata = JSON.parse(info.textContent) || {}; } catch (_) {}
        }
        const mime = String(metadata.mimeType || metadata.mime_type || '');
        if (/^(?:video|audio)\//i.test(mime) || document.querySelector('video')) return false;
        if (DOCUMENT_MIME.test(mime)) return true;

        const name = String(metadata.title || metadata.name || document.title || '').replace(/\s*-\s*Google Drive\s*$/i, '');
        if (DOCUMENT_EXTENSION.test(name)) return true;
        if (document.querySelector('[aria-label$=".pdf" i], [title$=".pdf" i], [data-tooltip$=".pdf" i]')) return true;

        // Files without an exposed extension/MIME can still show a rendered
        // page viewer. Reuse the same page detection used by PDF capture.
        return !!app.pdfCapture?.hasRenderedPages?.();
    }

    // Read only the currently visible attachment header. Never reuse a title
    // cached from another PDF opened earlier in the same Classroom tab.
    function getCurrentPreviewFilename() {
        const fileExtension = /\.(?:pdf|docx?|pptx?|odt|rtf)$/i;
        const candidates = [];
        const selectors = '[data-file-name],[data-document-title],h1,h2,[role="heading"],span[title],span[aria-label],span';
        for (const element of document.querySelectorAll(selectors)) {
            // Classroom may leave the previous document's title mounted. A
            // hidden or transitioning header is not the active attachment.
            let hidden = false;
            for (let node = element; node?.nodeType === 1; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' ||
                    style.display === 'none' || style.visibility === 'hidden' ||
                    style.opacity === '0') { hidden = true; break; }
            }
            if (hidden) continue;
            const bounds = element.getBoundingClientRect();
            if (!bounds.width || !bounds.height || bounds.top < 0 || bounds.top > 190 ||
                bounds.left < 0 || bounds.left >= innerWidth) continue;
            if (getComputedStyle(element).visibility === 'hidden') continue;
            const values = [element.getAttribute('data-file-name'),
                element.getAttribute('data-document-title'), element.getAttribute('title'),
                element.getAttribute('aria-label'), app.ui.ownText(element)];
            for (const value of values) {
                const name = String(value || '').trim();
                if (!name || name.length > 180 || !fileExtension.test(name)) continue;
                candidates.push({ name, top: bounds.top, left: bounds.left });
            }
        }
        // The file title is normally beside the PDF icon in the top toolbar.
        candidates.sort((a, b) => a.top - b.top || a.left - b.left);
        if (candidates.length) return candidates[0].name;
        return fileExtension.test(document.title.trim()) ? document.title.trim() : '';
    }

    const CLASSROOM_LOCK_MESSAGE = 'dpe-classroom-export-lock-v1';
    const CLASSROOM_LOCK_READY = 'dpe-classroom-export-lock-ready-v1';

    // The menu may be inside a cross-origin Drive iframe. Message the Classroom
    // top frame directly instead of waiting for the background frame scanner.
    // The iframe covers itself temporarily until the parent confirms the lock.
    window.addEventListener('message', event => {
        if (event.data?.type === CLASSROOM_LOCK_READY && window.top !== window &&
            event.origin === 'https://classroom.google.com' &&
            event.source === window.top &&
            event.data.jobId === pdf.temporaryClassroomLockJobId) {
            pdf.temporaryClassroomLockJobId = '';
            app.ui.showScrollDim(false);
            return;
        }
        if (event.data?.type !== CLASSROOM_LOCK_MESSAGE || window.top !== window ||
            location.hostname !== 'classroom.google.com' || event.source === window ||
            !/^https:\/\/(?:classroom|docs|drive)\.google\.com$|^https:\/\/[\w.-]+\.googleusercontent\.com$/.test(event.origin)) return;
        const jobId = String(event.data.jobId || '');
        if (!/^[0-9]{10,16}-[a-z0-9]{4,16}$/.test(jobId)) return;
        pdf.classroomJobId = jobId;
        pdf.dismissedClassroomJobId = '';
        pdf.classroomUiActive = true;
        pdf.classroomExportHandoff = true;
        pdf.stopRequested = false;
        app.ui.showInPageOverlay(true);
        app.ui.showScrollDim(true);
        app.ui.updateInPageOverlay('Preparing export', '', 0);
        try {
            event.source.postMessage({ type: CLASSROOM_LOCK_READY, jobId }, event.origin);
        } catch (_) { /* The viewer may have navigated. */ }
    });

    function lockClassroomOnClick(jobId) {
        if (window.top === window) {
            app.ui.showScrollDim(true);
            return;
        }
        // This call is synchronous with the click. It prevents interacting
        // with the embedded preview before the parent has drawn its dimmer.
        pdf.temporaryClassroomLockJobId = jobId;
        app.ui.showScrollDim(true, true);
        try {
            window.top.postMessage({ type: CLASSROOM_LOCK_MESSAGE, jobId },
                'https://classroom.google.com');
        } catch (_) { /* Background progress relay remains the fallback. */ }
    }

    function activateProtectedPDFDownload(event) {
        event.preventDefault();
        event.stopPropagation();
        // Capture the name before closing the menu or changing the viewer.
        const inClassroom = app.isClassroomViewer() || app.classroomPreviewTab === true ||
            pdf.classroomMenuHandoff === true;
        pdf.currentExportFilename = app.isClassroomViewer() &&
            location.hostname === 'classroom.google.com' ? getCurrentPreviewFilename() : '';
        pdf.classroomExportHandoff = inClassroom;
        pdf.classroomJobId = inClassroom
            ? `${Date.now()}-${Math.random().toString(36).slice(2)}` : '';
        pdf.classroomUiActive = inClassroom;
        pdf.dismissedClassroomJobId = '';
        app.ui.closeDriveFileMenu();
        app.pdfCapture?.resetForNewExport?.();
        // The new job is active; only Cancel should flip this flag back.
        pdf.stopRequested = false;
        app.ui.showInPageOverlay(true);
        // Lock immediately on the click, before asynchronous title resolution,
        // frame discovery or the service worker can delay the progress card.
        if (inClassroom) lockClassroomOnClick(pdf.classroomJobId);
        else app.ui.showScrollDim(true);
        if (inClassroom) {
            void chrome.runtime.sendMessage({
                action: 'classroomExportProgress',
                status: 'Preparing export',
                detail: '',
                filename: pdf.currentExportFilename || '',
                percent: 0, jobId: pdf.classroomJobId
            }).then(reply => {
                // If the fast window message was missed but the background
                // successfully displayed the parent overlay, release the
                // temporary iframe lock as well.
                if (reply?.success && pdf.temporaryClassroomLockJobId === pdf.classroomJobId) {
                    pdf.temporaryClassroomLockJobId = '';
                    app.ui.showScrollDim(false);
                }
            }).catch(() => {});
        }

        const root = document.getElementById('psd-inpage-overlay');
        root?.classList.remove('quiet', 'idle', 'completed', 'cancelled');
        root?.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Preparing export'));
        root?.querySelector('#psd-inpage-detail')?.replaceChildren(document.createTextNode(''));

        void start();
    }

    function findClassroomAction(menu, title) {
        const list = classroomMenuList(menu);
        if (list) return [...list.children].find(row =>
            row.matches('li') && classroomListActionName(row) === title) || null;
        // Older viewer layouts: use the last-known-working direct Print
        // anchor. Reject a grouped wrapper to avoid modifying Print/Details.
        const row = app.ui.findMenuRow(menu, title);
        if (!row) return null;
        const nestedLabels = [...row.querySelectorAll('[role="menuitem"],li')];
        return nestedLabels.length > 1 ? null : row;
    }

    function findClassroomOpenAction(menu) {
        const list = classroomMenuList(menu);
        if (list) {
            const row = [...list.children].find(candidate => {
                if (!candidate.matches('li')) return false;
                const text = String(candidate.getAttribute('aria-label') || candidate.textContent || '')
                    .replace(/\s+/g, ' ').trim();
                return /^Open(?:\s|$)/i.test(text);
            });
            if (row) return row;
        }
        return app.ui.findMenuRow(menu, 'Open');
    }

    function placeClassroomMenuRow(menu, item, printRow) {
        const anchor = findClassroomOpenAction(menu) || printRow;
        if (!anchor?.parentElement) return;
        if (item.previousElementSibling !== anchor) anchor.after(item);
        item.alignWithNativeRow?.();
    }

    const pendingClassroomMenuScans = new WeakSet();
    function isIdentityTransform(transform) {
        if (!transform || transform === 'none') return true;
        const matrix2d = transform.match(/matrix\(([^)]+)\)/)?.[1]
            ?.split(',').map(value => Number.parseFloat(value.trim()));
        const matrix3d = transform.match(/matrix3d\(([^)]+)\)/)?.[1]
            ?.split(',').map(value => Number.parseFloat(value.trim()));
        if (matrix2d && matrix2d.length >= 6 && matrix2d.every(Number.isFinite)) {
            const [a, b, c, d] = matrix2d;
            const scaleX = Math.hypot(a, b);
            const scaleY = Math.hypot(c, d);
            return Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01;
        }
        if (!matrix3d || matrix3d.length < 16 || matrix3d.some(value => !Number.isFinite(value))) return false;
        const scaleX = Math.hypot(matrix3d[0], matrix3d[1], matrix3d[2]);
        const scaleY = Math.hypot(matrix3d[4], matrix3d[5], matrix3d[6]);
        return Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01;
    }

    function classroomMenuVisualStateReady(menu) {
        for (let element = menu; element && element !== document.body; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                Number.parseFloat(style.opacity) < 0.99 || !isIdentityTransform(style.transform)) {
                return false;
            }
        }
        return true;
    }

    function classroomMenuLayoutSignature(menu, printRow) {
        if (!classroomMenuVisualStateReady(menu)) return '';
        const anchor = findClassroomOpenAction(menu) || printRow;
        if (!anchor?.isConnected || !printRow?.isConnected) return '';
        const label = printRow.querySelector('span.mUIrbf-vQzf8d') ||
            [...printRow.querySelectorAll('span, div')].find(el =>
                el.children.length === 0 && el.textContent.trim() === 'Print');
        const icon = printRow.querySelector('svg');
        const elements = [menu, anchor, printRow, label, icon];
        if (elements.some(element => {
            const rect = element?.getBoundingClientRect?.();
            return !rect || rect.width <= 0 || rect.height <= 0;
        })) return '';
        const labelStyle = getComputedStyle(label || printRow);
        const font = `${labelStyle.fontStyle} ${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`;
        if (document.fonts?.check && !document.fonts.check(font)) return '';
        return elements.map(element => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height]
                .map(value => Math.round(value * 10) / 10).join(',');
        }).join('|') + `|${font}|${labelStyle.lineHeight}`;
    }

    function waitForClassroomMenuLayout(menu, printRow) {
        if (pendingClassroomMenuScans.has(menu)) return;
        pendingClassroomMenuScans.add(menu);
        const begin = () => {
            if (!menu.isConnected) {
                pendingClassroomMenuScans.delete(menu);
                return;
            }
            const first = classroomMenuLayoutSignature(menu, printRow);
            if (!first) {
                pendingClassroomMenuScans.delete(menu);
                setTimeout(() => scheduleClassroomMenuScan(menu), 50);
                return;
            }
            requestAnimationFrame(() => {
                const second = classroomMenuLayoutSignature(menu, printRow);
                pendingClassroomMenuScans.delete(menu);
                if (first === second) scanMenu(menu);
                else scheduleClassroomMenuScan(menu);
            });
        };
        const fontsReady = document.fonts?.ready || Promise.resolve();
        Promise.resolve(fontsReady).then(() => requestAnimationFrame(begin), begin);
    }

    function scheduleClassroomMenuScan(menu) {
        if (!menu?.isConnected) return;
        const printRow = findClassroomAction(menu, 'Print');
        if (printRow) waitForClassroomMenuLayout(menu, printRow);
    }

    // Intentionally build a NEW row. Cloning Google menu markup causes its
    // internal menu reconciliation to rewrite Print and duplicate shortcuts.
    // A small shadow root isolates only our label/icon styles; the row itself
    // uses the native row's measured flex geometry.
    function createClassroomMenuRow(printRow, colorReference = printRow) {
        if (!printRow) return null;
        const item = document.createElement(printRow.tagName === 'LI' ? 'li' : 'div');
        item.id = MENU_ID;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', 'Export with Drive Preview Exporter');
        item.style.cssText = 'display:block;box-sizing:border-box;'
            + 'min-height:0;width:100%;cursor:pointer;overflow:hidden;list-style:none;'
            + 'margin:0;padding:0;';

        // LI itself cannot host Shadow DOM. Keep LI as the native UL sibling,
        // and isolate visual styles inside a shadow-host DIV.
        const content = document.createElement('div');
        content.style.cssText = 'display:block;width:100%;height:100%;';
        item.append(content);
        const shadow = content.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <style>
            :host { color:var(--dpe-menu-text); -webkit-text-fill-color:var(--dpe-menu-text); }
            .row {display:flex;align-items:center;box-sizing:border-box;width:100%;height:100%;min-height:0;}
            .icon {display:flex;align-items:center;justify-content:center;flex:0 0 auto;
              width:24px;height:24px;color:var(--dpe-menu-icon);-webkit-text-fill-color:var(--dpe-menu-icon);pointer-events:none}
            .icon svg {display:block;width:100%;height:100%;fill:currentColor}
            .label {display:flex;flex:0 1 auto;min-width:0;flex-direction:column;
              justify-content:center;align-items:flex-start;white-space:nowrap;pointer-events:none}
            .title {display:block;color:var(--dpe-menu-text);-webkit-text-fill-color:var(--dpe-menu-text);}
            .subtitle {display:block;margin-top:2px;color:var(--dpe-menu-muted);
              -webkit-text-fill-color:var(--dpe-menu-muted)}
          </style>
          <div class="row"><span class="icon" aria-hidden="true">${app.ui.downloadIconSvg}</span>
            <span class="label"><span class="title">Export</span>
              <span class="subtitle">Drive Preview Exporter</span></span></div>`;
        // The exact Drive icon path has generous whitespace in its original
        // viewBox. Keep the path, but crop only Classroom's icon viewport so
        // the artwork matches the visible size of native 24px menu icons.
        shadow.querySelector('.icon svg')?.setAttribute('viewBox', '96 192 768 768');

        const nativeLabel = printRow.querySelector('span.mUIrbf-vQzf8d') ||
            [...printRow.querySelectorAll('span, div')].find(el =>
                el.children.length === 0 && el.textContent.trim() === 'Print');
        const colorLabel = colorReference.querySelector('span.mUIrbf-vQzf8d') ||
            [...colorReference.querySelectorAll('span, div')].find(el =>
                el.children.length === 0 && el.textContent.trim() === 'Details');
        const nativeIcon = printRow.querySelector('svg');
        const nativeStyle = getComputedStyle(printRow);
        const labelStyle = getComputedStyle(nativeLabel || printRow);
        const colorStyle = getComputedStyle(colorLabel || colorReference);
        const iconStyle = getComputedStyle(nativeIcon || printRow);
        const parsePixels = value => {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        };
        const textColor = colorStyle.webkitTextFillColor &&
            colorStyle.webkitTextFillColor !== 'auto' ? colorStyle.webkitTextFillColor : colorStyle.color;
        const iconColor = iconStyle.color || textColor;
        content.style.setProperty('--dpe-menu-text', textColor || 'currentColor');
        content.style.setProperty('--dpe-menu-icon', iconColor || 'currentColor');
        content.style.setProperty('--dpe-menu-muted', 'color-mix(in srgb, currentColor 68%, transparent)');
        const title = shadow.querySelector('.title');
        const subtitle = shadow.querySelector('.subtitle');
        for (const element of [title, subtitle]) {
            element.style.fontFamily = labelStyle.fontFamily;
            element.style.fontWeight = labelStyle.fontWeight;
            element.style.letterSpacing = labelStyle.letterSpacing;
        }
        title.style.fontSize = labelStyle.fontSize;
        title.style.lineHeight = labelStyle.lineHeight;
        const titlePixels = parsePixels(labelStyle.fontSize) || 14;
        subtitle.style.fontSize = `${Math.max(10, Math.round(titlePixels * 0.78 * 10) / 10)}px`;
        subtitle.style.lineHeight = `${Math.max(12, Math.round(titlePixels * 1.05 * 10) / 10)}px`;
        title.style.webkitTextFillColor = textColor || 'currentColor';
        subtitle.style.webkitTextFillColor = 'color-mix(in srgb, currentColor 68%, transparent)';
        const row = shadow.querySelector('.row');
        content.style.height = '100%';
        row.style.height = '100%';
        row.style.paddingTop = nativeStyle.paddingTop;
        row.style.paddingRight = nativeStyle.paddingRight;
        row.style.paddingBottom = nativeStyle.paddingBottom;
        row.style.paddingLeft = nativeStyle.paddingLeft;
        row.style.fontFamily = labelStyle.fontFamily;
        row.style.fontSize = labelStyle.fontSize;
        row.style.color = textColor || 'currentColor';
        const nativeHeight = printRow.getBoundingClientRect().height || parsePixels(nativeStyle.height) || 44;
        const initialHeight = `${Math.ceil(nativeHeight)}px`;
        item.style.setProperty('height', initialHeight, 'important');
        item.style.setProperty('min-height', initialHeight, 'important');
        item.style.setProperty('max-height', initialHeight, 'important');

        // Align to the actual native icon/text columns after insertion. These
        // rectangles share the viewport coordinate system, so grouped menus
        // and their padding cannot introduce an extra offset.
        item.alignWithNativeRow = () => {
            if (!item.isConnected || !printRow.isConnected) return;
            const rowBounds = item.getBoundingClientRect();
            const printBounds = printRow.getBoundingClientRect();
            // Read the native icon/text offsets within Print itself. The
            // resulting padding and gap keep this row in normal flex layout,
            // including when Print lives inside a padded wrapper.
            const textBounds = nativeLabel?.getBoundingClientRect();
            const iconBounds = nativeIcon?.getBoundingClientRect();
            const iconX = iconBounds?.width ? iconBounds.left - printBounds.left : 0;
            const textX = textBounds?.width ? textBounds.left - printBounds.left : iconX + 44;
            const iconW = iconBounds?.width || 24;
            const iconH = iconBounds?.height || 24;
            const safeIconX = Math.max(0, Math.min(iconX, rowBounds.width - iconW));
            const gap = Math.max(0, textX - safeIconX - iconW);
            const iconEl = shadow.querySelector('.icon');
            iconEl.style.width = `${iconW}px`;
            iconEl.style.height = `${iconH}px`;
            row.style.paddingLeft = `${safeIconX}px`;
            row.style.columnGap = `${gap}px`;
            const paddingY = parsePixels(nativeStyle.paddingTop) + parsePixels(nativeStyle.paddingBottom);
            const labelHeight = shadow.querySelector('.label').getBoundingClientRect().height;
            const rowHeight = Math.ceil(Math.max(nativeHeight, labelHeight + paddingY));
            const height = `${rowHeight}px`;
            item.style.setProperty('height', height, 'important');
            item.style.setProperty('min-height', height, 'important');
            item.style.setProperty('max-height', height, 'important');
        };
        return item;
    }

    // Restore the simple Google Drive File-menu insertion from the last
    // confirmed-working (v1.9.12) build. Classroom's additional checks only
    // belong to embedded document viewers, never to a standalone Drive file.
    function isStandaloneDriveFile() {
        return app.isDrivePage?.() === true && window.top === window;
    }

    function standaloneDriveHasDocument() {
        if (document.querySelector('video')) return false;
        const title = String(document.title || '');
        if (/\.(?:pdf|docx?|pptx?|odt|rtf)(?:$|[?#]|\s*-\s*Google Drive)/i.test(title)) return true;
        const info = document.querySelector('#drive-active-item-info');
        if (info?.textContent) {
            try {
                const data = JSON.parse(info.textContent);
                const type = String(data?.mimeType || data?.mime_type || '');
                const name = String(data?.title || data?.name || '');
                if (DOCUMENT_MIME.test(type) || DOCUMENT_EXTENSION.test(name)) return true;
                if (/^(?:video|audio)\//i.test(type)) return false;
            } catch (_) { /* Drive does not always expose file metadata. */ }
        }
        if (document.querySelector('[aria-label*=".pdf" i], [title*=".pdf" i], [data-tooltip*=".pdf" i]')) return true;
        return !!app.pdfCapture?.hasRenderedPages?.();
    }

    function scanStandaloneDriveMenu(menu) {
        if (!document.body || !standaloneDriveHasDocument() || menu.querySelector(`#${MENU_ID}`)) return;
        const nativeDownload = app.ui.findMenuRow(menu, 'Download');
        const nativeDisabled = nativeDownload && (
            nativeDownload.getAttribute('aria-disabled') === 'true' ||
            nativeDownload.hasAttribute('disabled') ||
            nativeDownload.dataset.disabled === 'true' ||
            nativeDownload.classList.contains('disabled')
        );
        if (nativeDownload && !nativeDisabled) return;

        // Same template order and placement as the user's working Drive build.
        const templateRow = app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') ||
            app.ui.findMenuRow(menu, 'Security limitations') || nativeDownload;
        if (!templateRow) return;
        const item = app.ui.makeStandaloneMenuRow(templateRow, MENU_ID, 'Export');
        if (!item) return;
        app.ui.setDownloadMenuItemIcon(item);
        app.ui.styleDownloadMenuItem(item);
        app.ui.addMenuDescription(item, 'psd-pdf-menu-label',
            'psd-pdf-menu-info', 'Drive Preview Exporter');
        item.addEventListener('click', event => {
            pdf.classroomMenuHandoff = false;
            activateProtectedPDFDownload(event);
        });
        app.ui.handleMenuKeyboardActivation(item, event => {
            pdf.classroomMenuHandoff = false;
            activateProtectedPDFDownload(event);
        });
        app.ui.insertAfterReference(menu, item, app.ui.findShareRow(menu));
    }

    function scanMenu(menu) {
        if (isStandaloneDriveFile()) {
            scanStandaloneDriveMenu(menu);
            return;
        }
        if (!document.body) return;
        const classroomMenu = isEmbeddedClassroomFileMenu(menu);
        if (!classroomMenu && !app.isDocumentViewer()) return;
        // Never run the Drive cloning fallback on a Classroom-looking menu.
        // The old fallback could create another Export from the Print row.
        const classroomLayout = !!classroomMenuList(menu) || (!!menu.querySelector('span.mUIrbf-vQzf8d') &&
            ['Open', 'Details', 'Print'].every(label => [...menu.querySelectorAll('span.mUIrbf-vQzf8d')]
                .some(node => node.textContent.trim() === label)) &&
            ![...menu.querySelectorAll('span.mUIrbf-vQzf8d')]
                .some(node => node.textContent.trim() === 'Download'));
        if (!classroomMenu && (classroomLayout || app.isClassroomViewer() || app.classroomPreviewTab)) return;
        if (!classroomMenu && !isPageDocumentPreview()) return;
        const existing = menu.querySelector(`#${MENU_ID}`);
        if (existing) {
            // A recycled Classroom menu can contain an old hidden action.
            // Reinsert it only when the current visible menu has an anchor.
            if (existing.getBoundingClientRect().width > 0 &&
                existing.getBoundingClientRect().height > 0) {
                if (classroomMenu) {
                    placeClassroomMenuRow(menu, existing, findClassroomAction(menu, 'Print'));
                }
                return;
            }
            existing.remove();
        }

        const nativeDownload = app.ui.findMenuRow(menu, 'Download');
        const nativeDisabled = nativeDownload && (
            nativeDownload.getAttribute('aria-disabled') === 'true' ||
            nativeDownload.hasAttribute('disabled') ||
            nativeDownload.dataset.disabled === 'true' ||
            nativeDownload.classList.contains('disabled')
        );

        if (nativeDownload && !nativeDisabled) return;

        const printRow = classroomMenu ? findClassroomAction(menu, 'Print') : null;
        // Classroom only needs its Print anchor. Do not reject a valid
        // File menu because the unrelated Drive template lookup failed.
        const templateRow = classroomMenu ? null : (
            app.ui.findMenuRow(menu, 'Details') ||
            app.ui.findMenuRow(menu, 'Add to starred') ||
            app.ui.findMenuRow(menu, 'Security limitations') ||
            nativeDownload
        );
        if (classroomMenu ? !printRow : !templateRow) return;
        if (classroomMenu && !classroomMenuLayoutSignature(menu, printRow)) {
            waitForClassroomMenuLayout(menu, printRow);
            return;
        }

        const item = classroomMenu
            ? createClassroomMenuRow(
                printRow,
                findClassroomAction(menu, 'Details') || findClassroomAction(menu, 'Open') || printRow
            )
            : app.ui.makeStandaloneMenuRow(templateRow, MENU_ID, 'Export');
        if (!item) return;
        if (!classroomMenu) {
            app.ui.setDownloadMenuItemIcon(item);
            app.ui.addMenuDescription(
                item, 'psd-pdf-menu-label', 'psd-pdf-menu-info', 'Drive Preview Exporter'
            );
        }
        app.ui.styleDownloadMenuItem(item, '1', classroomMenu ? printRow : templateRow);
        if (classroomMenu) {
            item.dataset.psdClassroomExport = 'true';
        }
        const activate = event => {
            pdf.classroomMenuHandoff = classroomMenu;
            activateProtectedPDFDownload(event);
        };
        item.addEventListener('click', activate);
        app.ui.handleMenuKeyboardActivation(item, activate);
        if (classroomMenu) {
            // Insert one verified menu row immediately below Open. Never use
            // a group/container reference for insertion. Older viewers may
            // omit Open, so retain the safe Print anchor as a fallback.
            placeClassroomMenuRow(menu, item, printRow);
        } else {
            app.ui.insertAfterReference(menu, item, app.ui.findShareRow(menu));
        }
    }

    const CLASSROOM_BUTTON_ID = 'psd-classroom-export-header';
    const PREVIEW_TITLE_PATTERN = /\.(?:pdf|docx?|pptx?|odt|rtf)$/i;

    function updateClassroomHeaderButton() {
        // The embedded preview can be inaccessible to the outer Classroom
        // frame. This button starts the same frame-routing capture as the menu.
        if (location.hostname !== 'classroom.google.com' || window.top !== window) return;
        const existing = document.getElementById(CLASSROOM_BUTTON_ID);
        const fileMenu = app.ui.getDriveFileButton();
        const fileVisible = fileMenu && fileMenu.getBoundingClientRect().height > 0 &&
            fileMenu.getBoundingClientRect().top < 220;
        const titles = [...document.querySelectorAll('div,span,h1,h2')].filter(el => {
            const text = app.ui.ownText(el);
            if (!PREVIEW_TITLE_PATTERN.test(text) || text.length > 160) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 40 && rect.height > 0 && rect.top >= 0 && rect.top < 190;
        });
        const show = !!(fileVisible && titles.length && !document.querySelector('video'));
        if (!show) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const button = document.createElement('button');
        button.id = CLASSROOM_BUTTON_ID;
        button.type = 'button';
        button.textContent = 'Export PDF';
        button.title = 'Export the currently open Classroom document';
        button.style.cssText = 'position:fixed;top:72px;right:20px;z-index:2147483000;'
            + 'padding:8px 12px;border:1px solid #747775;border-radius:8px;'
            + 'background:#303134;color:#e8eaed;font:500 13px Arial,sans-serif;'
            + 'cursor:pointer;box-shadow:0 2px 8px #0003;';
        button.addEventListener('click', event => {
            pdf.classroomMenuHandoff = true;
            activateProtectedPDFDownload(event);
        });
        document.body.appendChild(button);
    }

    async function start() {
        const jobId = pdf.classroomJobId || '';
        const navigationPending = pdf.viewerNavigationPending === true;
        const navigationFingerprints = pdf.viewerNavigationFingerprints || null;
        const needsClassroomHandoff = pdf.classroomMenuHandoff ||
            (app.isClassroomViewer() && location.hostname === 'classroom.google.com');
        const receivedClassroomCapture = pdf.classroomCaptureHandoffReceived === true;
        pdf.classroomCaptureHandoffReceived = false;
        pdf.classroomMenuHandoff = false;
        if (needsClassroomHandoff && !receivedClassroomCapture) {
            try {
                pdf.currentExportFilename = location.hostname === 'classroom.google.com'
                    ? await waitForStablePreviewFilename(
                        '', pdf.viewerNavigationPending === true, pdf.lastExportedFilename || ''
                    )
                    : '';
                // Cancel may have arrived while waiting for Classroom's title.
                if (pdf.stopRequested || !pdf.classroomUiActive || pdf.classroomJobId !== jobId) return;
                app.ui.showInPageOverlay(true);
                app.ui.updateInPageOverlay('Preparing export', 'Waiting for the current preview…', 0);
                const result = await chrome.runtime.sendMessage({
                    action: 'startClassroomPreviewExport',
                    filename: pdf.currentExportFilename || '',
                    navigationPending, navigationFingerprints, jobId
                });
                if (jobId && pdf.classroomJobId !== jobId) return;
                if (result?.success) return;
                throw new Error(result?.error || 'Could not reach the document preview.');
            } catch (error) {
                if (jobId && pdf.classroomJobId !== jobId) return;
                if (pdf.classroomUiActive === false || pdf.status === 'cancelled') return;
                pdf.classroomExportHandoff = false;
                pdf.classroomUiActive = false;
                // A failed search is terminal: release the dimmer and allow
                // Close immediately, even if no capture ever started.
                pdf.classroomExportHandoff = false;
                pdf.classroomUiActive = false;
                pdf.status = 'idle';
                app.ui.failInPageOverlay('Preview unavailable', error.message || 'Pages are not accessible.');
                if (needsClassroomHandoff) {
                    void chrome.runtime.sendMessage({
                        action: 'classroomExportProgress',
                        status: 'Capture incomplete',
                        detail: error.message || 'Could not reach the document preview.',
                        filename: pdf.currentExportFilename || '',
                        percent: 0, jobId
                    }).catch(() => {});
                }
            }
            return;
        }
        // A new click always replaces any prior capture in this viewer.
        app.pdfCapture.resetForNewExport();
        app.pdfCapture.resetProgressUI();
        await app.pdfCapture.prepare();
    }

    async function waitForStablePreviewFilename(fallback = '', preferNew = false, previousName = '') {
        const previous = previousName || pdf.lastExportedFilename || '';
        const deadline = Date.now() + (preferNew ? 2200 : 500);
        let candidate = '';
        let stableSince = 0;
        while (Date.now() < deadline) {
            const current = getCurrentPreviewFilename();
            if (current && (!preferNew || current !== previous)) {
                if (current !== candidate) {
                    candidate = current;
                    stableSince = Date.now();
                } else if (Date.now() - stableSince >= 250) {
                    return current;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // If the viewer is still showing the previous title during a Next/
        // Previous transition, never reuse that title for a different PDF.
        if (preferNew && pdf.viewerNavigationPending) return candidate || '';
        return candidate || getCurrentPreviewFilename() || fallback || '';
    }

    function cancel() {
        if (pdf.status !== 'capturing' && pdf.status !== 'processing' &&
            !pdf.classroomUiActive && !pdf.classroomExportHandoff) return;
        pdf.stopRequested = true;
        pdf.runId = (pdf.runId || 0) + 1;
        pdf.classroomUiActive = false;
        pdf.classroomExportHandoff = false;
        app.pdfCapture.resetCaptureState();
        app.pdfCapture.finishCancelledCapture();
    }

    // The service worker can reach a PDF rendered in a nested Drive/Docs frame.
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.action === 'classroomPreviewNavigation') {
            pdf.viewerNavigationPending = request.pending !== false;
            if (pdf.viewerNavigationPending) app.ui.dismissFinishedClassroomOverlay?.();
            pdf.pendingDocumentFingerprint = null;
            if (pdf.viewerNavigationPending && Array.isArray(request.fingerprints)) {
                pdf.viewerNavigationFingerprints = request.fingerprints
                    .slice(0, 300).map(value => String(value).slice(0, 2000));
            } else if (!pdf.viewerNavigationPending) {
                pdf.viewerNavigationFingerprints = null;
            }
            sendResponse({ success: true });
        } else if (request?.action === 'getClassroomPreviewTitle') {
            sendResponse({ filename: getCurrentPreviewFilename() });
        } else if (request?.action === 'getStableClassroomPreviewTitle') {
            void waitForStablePreviewFilename(
                '', request.preferNew === true, String(request.previousFilename || '')
            ).then(filename => sendResponse({ filename }));
            return true;
        } else if (request?.action === 'probeClassroomPreviewPages') {
            if (location.hostname !== 'classroom.google.com') app.classroomPreviewTab = true;
            const filename = String(request.filename || '').trim();
            if (filename) pdf.currentExportFilename = filename;
            pdf.externalStaleFingerprints = Array.isArray(request.avoidFingerprints)
                ? request.avoidFingerprints : null;
            const fingerprints = app.pdfCapture?.probePageFingerprints?.() || [];
            sendResponse({ hasPages: fingerprints.length > 0 && !document.querySelector('video'),
                fingerprints, diagnostic: app.pdfCapture?.diagnosePageSurfaces?.() || null });
        } else if (request?.action === 'captureClassroomPreviewPages') {
            if (location.hostname !== 'classroom.google.com') app.classroomPreviewTab = true;
            pdf.currentExportFilename = String(request.filename || '').trim();
            pdf.classroomJobId = String(request.jobId || '');
            pdf.externalStaleFingerprints = Array.isArray(request.avoidFingerprints)
                ? request.avoidFingerprints : null;
            if (request.navigationPending === true && Array.isArray(request.navigationFingerprints)) {
                pdf.viewerNavigationPending = true;
                pdf.viewerNavigationFingerprints = request.navigationFingerprints
                    .slice(0, 300).map(value => String(value).slice(0, 2000));
                pdf.pendingDocumentFingerprint = null;
            }
            if (!app.pdfCapture?.hasRenderedPages?.()) {
                sendResponse({ success: false, error: 'The viewer has not rendered its first page yet.' });
            } else {
                // The top Classroom frame owns the visible progress card. The
                // renderer reports progress there, since an iframe overlay can
                // be clipped or hidden behind Classroom's preview layers.
                app.ui.showInPageOverlay(window.top === window);
                pdf.classroomCaptureHandoffReceived = true;
                void start();
                sendResponse({ success: true });
            }
        } else if (request?.action === 'classroomExportProgressUpdate') {
            if (request.jobId && pdf.dismissedClassroomJobId === request.jobId) {
                sendResponse({ success: false, cancelled: true });
                return;
            }
            const newJob = request.status === 'Preparing export' && Boolean(request.jobId) &&
                request.jobId !== pdf.classroomJobId;
            if (request.jobId && pdf.classroomJobId && request.jobId !== pdf.classroomJobId &&
                !newJob) {
                sendResponse({ success: false, stale: true });
                return;
            }
            if (newJob) {
                if (pdf.classroomUiActive || pdf.status === 'capturing' || pdf.status === 'processing') {
                    sendResponse({ success: false, busy: true });
                    return;
                }
                // The old PDF's completion card must not suppress the new
                // job's progress. New jobs are announced by the background.
                pdf.classroomJobId = request.jobId;
                pdf.dismissedClassroomJobId = '';
                pdf.currentExportFilename = '';
                pdf.status = 'idle';
                pdf.stopRequested = false;
                app.ui.showInPageOverlay(false);
            }
            if (request.jobId) pdf.classroomJobId = request.jobId;
            if (typeof request.filename === 'string' && request.filename.trim()) {
                pdf.currentExportFilename = request.filename.trim();
            }
            if (request.status === 'File exported') {
                pdf.classroomUiActive = false;
                pdf.lastExportedFilename = pdf.currentExportFilename || '';
                pdf.viewerNavigationPending = false;
                void chrome.runtime.sendMessage({
                    action: 'classroomPreviewNavigation', pending: false
                }).catch(() => {});
                app.ui.showInPageOverlay(true);
                app.ui.completeInPageOverlay();
            } else if (request.status === 'Export cancelled') {
                pdf.classroomUiActive = false;
                pdf.viewerNavigationPending = false;
                void chrome.runtime.sendMessage({
                    action: 'classroomPreviewNavigation', pending: false
                }).catch(() => {});
                app.ui.showInPageOverlay(true);
                app.ui.cancelInPageOverlay();
            } else if (request.status === 'Capture incomplete' || request.status === 'PDF conversion failed') {
                pdf.classroomUiActive = false;
                pdf.viewerNavigationPending = false;
                void chrome.runtime.sendMessage({
                    action: 'classroomPreviewNavigation', pending: false
                }).catch(() => {});
                app.ui.failInPageOverlay(request.status, request.detail);
            } else {
                if (pdf.classroomUiActive === false && pdf.stopRequested) {
                    sendResponse({ success: false, cancelled: true });
                    return;
                }
                pdf.classroomUiActive = true;
                pdf.classroomExportHandoff = true;
                app.ui.showInPageOverlay(true);
                app.ui.showScrollDim(true);
                app.ui.updateInPageOverlay(request.status, request.detail, request.percent);
            }
            sendResponse({ success: true });
        } else if (request?.action === 'cancelClassroomExportInFrame') {
            if (request.jobId && pdf.classroomJobId && request.jobId !== pdf.classroomJobId) {
                sendResponse({ success: false, stale: true });
            } else {
                cancel();
                sendResponse({ success: true });
            }
        }
    });

    app.pdf = {
        isPageDocumentPreview,
        start,
        cancel,
        scanMenu,
        updateClassroomHeaderButton
    };
})();
