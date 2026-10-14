(() => {
    if (window.__PSD_LOADED) return;
    window.__PSD_LOADED = true;

    const app = window.__PSD = window.__PSD || {};
    const pdf = app.pdfState = app.pdfState || {
        status: 'idle',
        stopRequested: false,
        capturedPages: new Map(),
        unsupportedTimer: null
    };
    app.videoState = app.videoState || {
        fileId: '',
        viewerSessionId: '',
        pageBridgeId: '',
        formats: { video: [], audio: [], progressive: [] },
        pickerFormats: null,
        scanCache: null,
        restorePickerOnFileMenuOpen: false,
        playbackStarted: false,
        operation: 'idle',
        lastViewerState: false,
        lastFilenameSent: '',
        bridgeReplayAt: {},
        playbackQualityHeights: [],
        playbackQualityLabels: [],
        playbackQualityFileId: ''
    };

    app.ids = {
        pdfMenu: 'psd-protected-download-menuitem',
        videoMenu: 'psd-protected-video-menuitem'
    };

    const sendAction = (action, data = {}) => {
        try {
            chrome.runtime.sendMessage({ action, ...data }).catch?.(() => {});
        } catch (_) {}
    };
    const isDrivePage = () => (location.hostname === 'drive.google.com' || location.hostname.endsWith('.drive.google.com')) && /^\/file(?:\/|$)/.test(location.pathname);
    // Classroom opens files in an embedded page viewer instead of a Drive /file tab.
    const isClassroomViewer = () => location.hostname === 'classroom.google.com' ||
        (location.hostname.endsWith('drive.google.com') && (() => {
            try { return new URL(document.referrer).hostname === 'classroom.google.com'; }
            catch (_) { return false; }
        })()) ||
        (location.hostname === 'docs.google.com' && /^\/(?:gview|viewer)/.test(location.pathname)) ||
        (location.hostname.endsWith('.googleusercontent.com') &&
            /^(?:classroom|drive)\.google\.com$/.test((() => {
                try { return new URL(document.referrer).hostname; } catch (_) { return ''; }
            })()));
    const isDocumentViewer = () => isDrivePage() || isClassroomViewer() || app.classroomPreviewTab === true;
    const isPDFBusy = () => pdf.status === 'capturing' || pdf.status === 'processing';

    const normalizeMenuText = value => String(value).replace(/\s+/g, ' ').trim();

    // Text-node helpers (same idea as the menu+quality reference). No jsname / data-* selectors.
    const ownText = el =>
        [...(el?.childNodes || [])]
            .filter(n => n.nodeType === 3)
            .map(n => n.nodeValue)
            .join('')
            .replace(/\s+/g, ' ')
            .trim();

    const findLabel = (root, text) => {
        const target = normalizeMenuText(text);
        if (!root || !target) return null;
        return [root, ...root.querySelectorAll('*')].find(el => ownText(el) === target) || null;
    };

    // First short own-text node under a menuitem — the visible label, not shortcut/meta.
    const findPrimaryLabel = root => {
        if (!root) return null;
        for (const el of [root, ...root.querySelectorAll('*')]) {
            const t = ownText(el);
            if (t && t.length > 0 && t.length < 48) return el;
        }
        return null;
    };

    const getMenuLabel = item => {
        const primary = findPrimaryLabel(item);
        if (primary) return normalizeMenuText(ownText(primary));
        return normalizeMenuText(item?.textContent || '');
    };

    function findMenuRow(menu, wanted) {
        const target = normalizeMenuText(wanted).toLowerCase();
        const candidates = [
            ...menu.querySelectorAll('[role="menuitem"], [role="option"], li, button')
        ];
        const standard = candidates.find(el => el !== menu && getMenuLabel(el).toLowerCase() === target);
        if (standard) return standard;

        // Classroom's embedded viewer sometimes renders Material-menu labels
        // without role="menuitem". The recorded viewer uses this label class.
        const labels = [...menu.querySelectorAll('span.mUIrbf-vQzf8d')];
        const label = labels.find(el => normalizeMenuText(el.textContent).toLowerCase() === target);
        if (!label) return null;
        let row = label;
        while (row.parentElement && row.parentElement !== menu) {
            const parent = row.parentElement;
            const siblingLabels = [...parent.querySelectorAll('span.mUIrbf-vQzf8d')];
            if (siblingLabels.some(el => el !== label &&
                normalizeMenuText(el.textContent) !== normalizeMenuText(label.textContent))) break;
            row = parent;
        }
        return row === label ? label.parentElement || label : row;
    }
    const findShareRow = menu => findMenuRow(menu, 'Share');

    function insertAfterReference(parent, node, reference) {
        if (!node) return;
        if (reference?.parentNode) {
            // Prefer native after() (reference style).
            if (typeof reference.after === 'function') reference.after(node);
            else reference.parentNode.insertBefore(node, reference.nextSibling);
        } else if (parent) {
            parent.appendChild(node);
        }
    }

    // Strip Drive's action/identity attrs the way the reference does (js*, data-*, aria-*).
    const STRIP_ATTR = /^(id|role|tabindex|js.*|data-.*|aria-.*)$/i;

    function makeStandaloneMenuRow(source, id, label) {
        if (!source) return null;
        const item = source.cloneNode(true);
        for (const el of [item, ...item.querySelectorAll('*')]) {
            for (const { name } of [...el.attributes]) {
                if (STRIP_ATTR.test(name)) el.removeAttribute(name);
            }
        }
        item.id = id;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', label);

        // Prefer replacing the template's own label text (e.g. "Share"); else first primary label.
        const labelNode =
            findLabel(item, getMenuLabel(source)) ||
            findPrimaryLabel(item);
        if (labelNode) {
            labelNode.textContent = label;
            // Hide non-label chrome (submenu >, shortcuts, etc.), but keep icon slots visible.
            for (const el of item.querySelectorAll('*')) {
                el.style.pointerEvents = 'none';
                if (el === labelNode || el.contains(labelNode) || labelNode.contains(el)) continue;
                if (el.tagName === 'SVG' || el.querySelector?.('svg')) continue;
                el.style.visibility = 'hidden';
            }
            labelNode.style.visibility = 'visible';
            labelNode.style.pointerEvents = 'none';
            // Keep ancestors of the label visible so layout is preserved.
            let p = labelNode.parentElement;
            while (p && p !== item) {
                p.style.visibility = 'visible';
                p = p.parentElement;
            }
            item.style.pointerEvents = 'auto';
        } else {
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                if (normalizeMenuText(walker.currentNode.nodeValue)) {
                    walker.currentNode.nodeValue = label;
                    break;
                }
            }
        }
        return item;
    }
    function getVisibleFileMenus() {
        const isVisible = el => {
            const rect = el.getBoundingClientRect?.();
            return rect?.width > 0 && rect?.height > 0 &&
                getComputedStyle(el).visibility !== 'hidden';
        };
        // Look for a native Print action (possibly followed by Ctrl+P),
        // rather than requiring exact labels for every command in the menu.
        // The v1.9.27 direct-insertion build did not have that strict gate.
        const action = row => {
            const aria = normalizeMenuText(row.getAttribute('aria-label') || '');
            const visible = normalizeMenuText(row.textContent || '');
            for (const [name, pattern] of [
                ['Print', /^Print(?=\s|Ctrl\s*\+\s*P|$)/i],
                ['Details', /^Details(?=\s|D$|$)/i],
                ['Open', /^Open(?=\W|$)/i]
            ]) if (pattern.test(aria) || pattern.test(visible)) return name;
            return '';
        };
        const nativeLists = [...document.querySelectorAll('ul')].filter(list => {
            if (!isVisible(list)) return false;
            const names = [...list.children].filter(row => row.tagName === 'LI').map(action);
            return names.includes('Print') &&
                (names.includes('Details') || names.includes('Open'));
        });
        const menus = [...nativeLists];
        for (const menu of document.querySelectorAll('[role="menu"], .goog-menu, #docs-file-menu')) {
            if (isVisible(menu) && !nativeLists.some(list => menu.contains(list))) menus.push(menu);
        }

        // Compatibility with older, div-based embedded viewers.
        for (const label of document.querySelectorAll('span.mUIrbf-vQzf8d')) {
            if (normalizeMenuText(label.textContent) !== 'Print' || !isVisible(label)) continue;
            let parent = label.parentElement;
            for (let depth = 0; parent && depth < 12; depth++, parent = parent.parentElement) {
                if (!isVisible(parent)) break;
                const texts = new Set([...parent.querySelectorAll('span.mUIrbf-vQzf8d')]
                    .map(el => normalizeMenuText(el.textContent)));
                if (['Open', 'Details', 'Print'].every(text => texts.has(text))) {
                    if (!menus.some(menu => menu.contains(parent) || parent.contains(menu))) menus.push(parent);
                    break;
                }
            }
        }
        return menus;
    }
    function getDriveFileButton() {
        return [...document.querySelectorAll('[role="button"],button')].find(el => {
            if (!el.offsetParent) return false;
            return normalizeMenuText(el.getAttribute('aria-label') || '') === 'File' ||
                normalizeMenuText(el.textContent || '') === 'File';
        }) || null;
    }

    function closeDriveFileMenu() {
        // File is a toggle button: clicking when already closed REOPENS the menu.
        // Only act when a menu is actually visible or aria-expanded is true.
        try {
            const fileButton = getDriveFileButton();
            const expanded = String(fileButton?.getAttribute('aria-expanded') || '').toLowerCase();
            const menuOpen = getVisibleFileMenus().length > 0;
            if (!menuOpen && expanded !== 'true') {
                return false; // already closed — do not toggle open
            }
            if (fileButton && (menuOpen || expanded === 'true')) {
                fileButton.click();
                return true;
            }
        } catch (_) {}
        try {
            // Escape only when something still looks open
            if (getVisibleFileMenus().length > 0) {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                }));
                return true;
            }
        } catch (_) {}
        return false;
    }

    // One download icon for Drive and Classroom menu actions.
    const DOWNLOAD_ICON_SVG = [
        '<svg height="24" viewBox="0 96 960 960" width="24" fill="currentColor">',
        '<path fill="currentColor" d="M240 896q-33 0-56.5-23.5T160 816V696h80v120h480V696h80v120q0 33-23.5 56.5T720 896H240Zm240-160L280 536l56-58 104 104V256h80v326l104-104 56 58-200 200Z"></path>',
        '</svg>'
    ].join('');
    const DOWNLOAD_ICON = `<span aria-hidden="true">${DOWNLOAD_ICON_SVG}</span>`;

    function setDownloadMenuItemIcon(item) {
        if (!item) return;
        // Prefer an existing SVG slot; otherwise the first child that already holds an icon.
        const host = item.querySelector('svg')?.parentElement || item.firstElementChild;
        if (!host) return;
        host.innerHTML = DOWNLOAD_ICON;
        host.style.visibility = 'visible';
        let p = host.parentElement;
        while (p && p !== item) {
            p.style.visibility = 'visible';
            p = p.parentElement;
        }
        const label = findPrimaryLabel(item);
        const color = label ? getComputedStyle(label).color : '';
        if (color) host.style.color = color;
    }
    let menuStylesInstalled = false;
    function ensureMenuStyles() {
        if (menuStylesInstalled || document.getElementById('psd-menu-styles')) return;
        const style = document.createElement('style');
        style.id = 'psd-menu-styles';
        style.textContent = `
            [data-psd-menu-item="true"] {
                background-color: transparent;
                color: inherit;
                -webkit-text-fill-color: currentColor;
            }
            [data-psd-menu-item="true"]:hover,
            [data-psd-menu-item="true"]:focus-visible,
            [data-psd-menu-item="true"].goog-menuitem-highlight {
                background-color: color-mix(in srgb, currentColor 9%, transparent) !important;
                background-image: none !important;
            }
            [data-psd-menu-item="true"]:focus-visible { outline: none !important; }
            [data-psd-menu-item="true"] .psd-menu-description {
                display: block;
                margin-top: 2px;
                color: color-mix(in srgb, currentColor 68%, transparent);
                -webkit-text-fill-color: color-mix(in srgb, currentColor 68%, transparent);
                font: 400 .78em/1.2 Roboto, Arial, sans-serif;
                white-space: nowrap;
            }
        `;
        (document.head || document.documentElement).append(style);
        menuStylesInstalled = true;
    }
    function styleDownloadMenuItem(item, opacity = '1') {
        ensureMenuStyles();
        item.dataset.psdMenuItem = 'true';
        item.style.cursor = 'pointer';
        item.style.opacity = opacity;
        item.style.pointerEvents = 'auto';
        item.style.boxSizing = 'border-box';
        item.style.maxWidth = '100%';
    }
    function handleMenuKeyboardActivation(item, activate) {
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event);
        });
    }
    function addMenuDescription(item, labelClass, infoClass, text) {
        const label = item.querySelector(`.${labelClass}`) || findPrimaryLabel(item);
        if (!label || item.querySelector(`.${infoClass}`)) return;
        label.classList.add(labelClass);
        const parent = label.parentElement;
        if (!parent) return;
        const info = Object.assign(document.createElement('span'), { className: infoClass, textContent: text });
        info.classList.add('psd-menu-description');
        info.style.cssText = 'box-sizing:border-box;width:100%;max-width:100%;white-space:normal;overflow-wrap:anywhere;word-break:normal;overflow:hidden;';
        parent.append(info);
        Object.assign(parent.style, { display:'flex', flexDirection:'column', alignItems:'flex-start', flex:'1 1 0', width:'0', minWidth:'0', maxWidth:'100%', overflow:'hidden', justifyContent:'center' });
    }

    const INPAGE_OVERLAY_HTML = `
      <style>
#psd-inpage-overlay { position:fixed; right:24px; bottom:24px; z-index:2147483646; pointer-events:none; font:14px/1.4 'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e3e3e3; -webkit-font-smoothing:antialiased }
#psd-inpage-card { width:360px; max-width:calc(100vw - 32px); background:#28292a; border:none; outline:none; border-radius:20px; box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2); overflow:hidden; pointer-events:auto; position:relative }
#psd-inpage-body { padding:16px 18px }
#psd-inpage-head { display:grid; grid-template-columns:36px minmax(0,1fr) auto; align-items:center; column-gap:14px; min-height:36px; position:relative }
#psd-inpage-spinner,#psd-inpage-check { width:36px; height:36px; flex:0 0 36px; position:relative }
#psd-inpage-spinner svg,#psd-inpage-check svg { display:block; width:36px; height:36px }
#psd-inpage-spinner svg { transform:rotate(-90deg); overflow:visible }
#psd-inpage-spinner .psd-ring-bg { fill:none; stroke:#444746; stroke-width:3.5 }
#psd-inpage-spinner .psd-ring { fill:none; stroke:#a8c7fa; stroke-width:3.5; stroke-linecap:round; stroke-dasharray:106.814150222; stroke-dashoffset:106.814150222; transition:stroke-dashoffset .15s linear; transform-box:fill-box; transform-origin:center }
#psd-inpage-check { display:none }
#psd-inpage-check circle { fill:none; stroke:#81c995; stroke-width:3.5 }
#psd-inpage-check path { fill:none; stroke:#81c995; stroke-width:3.5; stroke-linecap:round; stroke-linejoin:round }
#psd-inpage-title { font-size:15px; line-height:20px; white-space:nowrap; font-weight:500; color:#e3e3e3; letter-spacing:.1px }
#psd-inpage-detail { margin-top:3px; font-size:13px; color:#c4c7c5; line-height:1.4; min-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
#psd-inpage-actions { display:flex; align-items:center; justify-content:center; margin:0; align-self:center }
#psd-inpage-toggle { display:block; border:none; outline:none; border-radius:20px; padding:7px 18px; background:rgba(168,199,250,.12); color:#a8c7fa; cursor:pointer; font:500 13px 'Google Sans',Roboto,sans-serif }
#psd-inpage-toggle:hover { background:rgba(168,199,250,.22) }
#psd-inpage-toggle:focus-visible { outline:2px solid #a8c7fa; outline-offset:1px }
#psd-video-download { display:none }
#psd-inpage-close { display:none; position:absolute; top:10px; right:10px; width:30px; height:30px; border:0; border-radius:50%; background:transparent; color:#c4c7c5; font:18px/30px Arial,sans-serif; cursor:pointer; padding:0; text-align:center }
#psd-inpage-close:hover { background:rgba(255,255,255,.08); color:#e3e3e3 }
#psd-inpage-overlay.completed #psd-inpage-close { display:block }
#psd-inpage-overlay.completed #psd-inpage-toggle { display:none }
#psd-inpage-overlay.cancelled #psd-inpage-card { width:auto; min-width:190px }
#psd-inpage-overlay.cancelled #psd-inpage-body { padding:16px 20px }
#psd-inpage-overlay.cancelled #psd-inpage-spinner,#psd-inpage-overlay.cancelled #psd-inpage-actions { display:none }
#psd-inpage-close:focus-visible { outline:2px solid #8ab4f8; outline-offset:1px }
#psd-inpage-overlay.completed #psd-inpage-spinner { display:none }
#psd-inpage-overlay.completed #psd-inpage-check { display:block }
#psd-inpage-overlay.completed #psd-inpage-detail { display:none }
#psd-inpage-overlay.completed #psd-inpage-head { grid-template-columns:36px minmax(0,1fr) 28px; column-gap:14px }
#psd-inpage-overlay.completed #psd-inpage-close { display:block; position:static; grid-column:3; grid-row:1; width:28px; height:28px; line-height:28px; margin:0; text-align:center }
#psd-inpage-overlay.cancelled #psd-inpage-title { font-size:16px; line-height:20px; white-space:nowrap }
      </style>
      <div id="psd-inpage-card"><div id="psd-inpage-body"><div id="psd-inpage-head">
        <div id="psd-inpage-spinner" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="psd-ring-bg" cx="20" cy="20" r="17"></circle><circle id="psd-inpage-ring" class="psd-ring" cx="20" cy="20" r="17"></circle></svg></div>
        <div id="psd-inpage-check" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17"></circle><path d="M11.5 20.5 17 26l11.5-12"></path></svg></div>
        <div><div id="psd-inpage-title">Preparing export</div><div id="psd-inpage-detail"></div></div>
        <div id="psd-inpage-actions"><button id="psd-inpage-toggle" type="button">Cancel</button></div><button id="psd-inpage-close" aria-label="Close">×</button>
      </div></div></div>`;

    function createInPageOverlayRoot() {
        const root = document.createElement('div');
        root.id = 'psd-inpage-overlay';
        root.innerHTML = INPAGE_OVERLAY_HTML;
        return root;
    }

    function bindInPageOverlayEvents(root) {
        const cancelButton = root.querySelector('#psd-inpage-toggle');
        const closeButton = root.querySelector('#psd-inpage-close');
        cancelButton.onclick = () => {
            if (!isPDFBusy()) return;
            root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Cancelling export'));
            app.pdf?.cancel?.();
        };
        closeButton.onclick = () => {
            if (!isPDFBusy()) {
                showInPageOverlay(false);
                return;
            }
            if (pdf.stopRequested) return;
            root.classList.remove('completed', 'unsupported', 'cancelled');
            root.querySelector('#psd-inpage-title')?.replaceChildren(document.createTextNode('Cancelling export'));
            app.pdf?.cancel?.();
            const detail = root.querySelector('#psd-inpage-detail');
            if (detail) detail.textContent = '';
        };
    }
    const SCROLL_MESSAGE = `<div id="psd-scroll-dim-msg" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(420px,calc(100vw - 48px));text-align:center;pointer-events:none;user-select:none;">
        <div style="font:500 17px/1.35 'Google Sans',Roboto,Arial,sans-serif;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.7);margin-bottom:8px;">Stay on this tab until the export finishes</div>
        <div style="font:400 13px/1.4 Roboto,Arial,sans-serif;color:rgba(255,255,255,.72);text-shadow:0 1px 3px rgba(0,0,0,.6);">Leaving this tab may interrupt page capture</div>
    </div>`;

    function createInPageOverlay() {
        const host = document.body || document.documentElement;
        let dim = document.getElementById('psd-scroll-dim');
        if (!dim) {
            dim = document.createElement('div');
            dim.id = 'psd-scroll-dim';
            dim.setAttribute('aria-hidden', 'true');
            dim.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.80);pointer-events:auto;display:none;';
            dim.innerHTML = SCROLL_MESSAGE;
            host.appendChild(dim);
        }

        if (document.getElementById('psd-inpage-overlay')) return;
        const root = createInPageOverlayRoot();
        host.appendChild(root);
        root.style.display = 'none';
        bindInPageOverlayEvents(root);
    }
    function updateWindowControl() {
        const root = document.getElementById('psd-inpage-overlay');
        if (root && isPDFBusy()) root.classList.remove('idle', 'cancelled');
    }
    function showScrollDim(show = true) {
        const dim = document.getElementById('psd-scroll-dim');
        if (!dim) return;
        if (show && !dim.querySelector('#psd-scroll-dim-msg')) {
            dim.innerHTML = SCROLL_MESSAGE;
        }
        dim.style.display = show ? 'block' : 'none';
    }
    function showInPageOverlay(show = true) {
        createInPageOverlay();
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;
        root.style.display = show ? 'block' : 'none';
        if (show) {
            root.classList.remove('cancelled', 'completed', 'unsupported');
            root.querySelector('#psd-inpage-spinner')?.style.setProperty('display', 'block');
            root.querySelector('#psd-inpage-check')?.style.setProperty('display', 'none');
            root.querySelector('#psd-inpage-actions')?.style.setProperty('display', 'flex');
            const toggle = root.querySelector('#psd-inpage-toggle');
            if (toggle) {
                toggle.style.display = 'block';
                toggle.disabled = false;
                toggle.textContent = 'Cancel';
            }
        }
        updateWindowControl();
    }
    const INPAGE_RING_CIRCUMFERENCE = 2 * Math.PI * 17;
    function updateInPageOverlay(status, detail, percent) {
        const root = document.getElementById('psd-inpage-overlay');
        if (!root) return;
        const title = root.querySelector('#psd-inpage-title');
        const detailEl = root.querySelector('#psd-inpage-detail');
        if (title && !root.classList.contains('cancelled')) {
            const label = String(status || '');
            if (/^File exported$/i.test(label)) title.textContent = 'File exported';
            else if (/^PDF conversion failed$/i.test(label)) title.textContent = 'PDF conversion failed';
            else if (/^PDF incomplete$/i.test(label)) title.textContent = 'PDF incomplete';
            else if (/^Some pages were not captured$/i.test(label)) title.textContent = 'Capture incomplete';
            else title.textContent = 'Preparing export';
        }
        if (detailEl && !root.classList.contains('cancelled')) {
            const text = String(detail || '');
            if (/^(?:Processing page|OCR page)\b/i.test(text)) detailEl.textContent = text;
            else if (/^Preparing page\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing page/i, 'Capturing page');
            else if (/^Preparing pages\b/i.test(text)) detailEl.textContent = text.replace(/^Preparing pages/i, 'Capturing');
            else if (/^Preparing your PDF/i.test(text)) detailEl.textContent = 'Preparing PDF…';
            else detailEl.textContent = text;
        }
        if (typeof percent === 'number') {
            const safePercent = Math.max(0, Math.min(100, percent));
            const ring = root.querySelector('#psd-inpage-ring');
            const offset = INPAGE_RING_CIRCUMFERENCE * (1 - safePercent / 100);
            if (ring) {
                ring.style.strokeDasharray = String(INPAGE_RING_CIRCUMFERENCE);
                ring.style.strokeDashoffset = String(offset);
            }
        }
    }

    function scanDriveMenus() {
        const menus = getVisibleFileMenus();
        void app.video?.scanViewerState().catch(error => {
            console.warn('[Drive Preview Exporter] viewer state scan failed:', error);
        });
        for (const menu of menus) {
            app.video?.scanMenu(menu);
            app.pdf?.scanMenu(menu);
        }
        app.pdf?.updateClassroomHeaderButton?.();
    }
    let watchingMenus = false;
    function watchDriveMenus() {
        if (!isDocumentViewer() || watchingMenus) return;
        watchingMenus = true;
        scanDriveMenus();
        let scanTimer = null;
        const scheduleScan = () => {
            if (scanTimer) return;
            scanTimer = setTimeout(() => { scanTimer = null; scanDriveMenus(); }, 100);
        };
        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-hidden', 'aria-expanded', 'class', 'style']
        });
        setInterval(scheduleScan, 1000);
    }

    app.sendAction = sendAction;
    app.isDrivePage = isDrivePage;
    app.isClassroomViewer = isClassroomViewer;
    app.isDocumentViewer = isDocumentViewer;
    app.ui = {
        ownText,
        findLabel,
        findPrimaryLabel,
        getMenuLabel,
        getVisibleFileMenus,
        findMenuRow,
        findShareRow,
        insertAfterReference,
        makeStandaloneMenuRow,
        getVisibleFileMenus,
        getDriveFileButton,
        closeDriveFileMenu,
        setDownloadMenuItemIcon,
        downloadIconSvg: DOWNLOAD_ICON_SVG,
        styleDownloadMenuItem,
        handleMenuKeyboardActivation,
        addMenuDescription,
        showScrollDim,
        showInPageOverlay,
        updateInPageOverlay,
        updateWindowControl
    };

    app.init = function init() {
        if (app.isDrivePage()) app.video?.init();
        const enableDocumentViewer = () => {
            createInPageOverlay();
            void app.startPendingDocsExport?.();
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', watchDriveMenus, { once: true });
            } else {
                watchDriveMenus();
            }
        };
        if (app.isDocumentViewer()) enableDocumentViewer();

        // Some Classroom attachment frames have a Docs/Drive URL that is not
        // /file/d/... and whose referrer is not Classroom. Ask the service worker
        // about the containing tab before injecting anything into that frame.
        if (window.top !== window && /^(?:docs\.google\.com|(?:[\w-]+\.)?drive\.google\.com|[\w.-]+\.googleusercontent\.com)$/.test(location.hostname)) {
            void chrome.runtime.sendMessage({ action: 'isClassroomPreviewTab' }).then(reply => {
                if (!reply?.classroom) return;
                app.classroomPreviewTab = true;
                if (!watchingMenus) enableDocumentViewer();
                else scanDriveMenus();
            }).catch(() => {});
        }
    };
})();
