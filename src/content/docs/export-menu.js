(() => {
    if (window.__DPE_DOCS_MENU) return;
    window.__DPE_DOCS_MENU = true;

    const MENU_ID = 'dpe-export-from-docs';
    const LABEL = 'Export with Drive Preview Exporter';
    const SUBMENU_CLASS = /submenu|sub-menu|haspopup|has-menu|menu-arrow|menu-caret/i;
    const getDocumentId = () => location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)?.[1];
    if (!getDocumentId()) return;

    function isVisible(element) {
        return element.getClientRects().length > 0 &&
            element.getAttribute('aria-hidden') !== 'true' &&
            getComputedStyle(element).visibility !== 'hidden';
    }

    function findDownloadRow(menu) {
        for (const row of menu.querySelectorAll('[role="menuitem"], .goog-menuitem, .apps-menuitem')) {
            if (row.id === MENU_ID || row.closest(`#${MENU_ID}`)) continue;
            const label = row.querySelector('.goog-menuitem-label') ||
                row.querySelector('.goog-menuitem-content') || row;
            const text = (label.getAttribute('aria-label') || label.textContent || '')
                .replace(/\s+/g, ' ').trim();
            if (/^Download(?:\b|$)/i.test(text)) return row;
        }
        return null;
    }

    function showMessage(message) {
        document.getElementById('dpe-docs-message')?.remove();
        const notice = document.createElement('div');
        notice.id = 'dpe-docs-message';
        notice.setAttribute('role', 'status');
        notice.textContent = message;
        notice.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:340px;padding:14px 18px;border-radius:14px;background:#28292a;color:#e3e3e3;font:13px/1.5 Arial,sans-serif;box-shadow:0 3px 18px #0005;';
        document.body.append(notice);
        setTimeout(() => notice.remove(), 7000);
    }

    async function activate(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'beginGoogleDocExport', documentId: getDocumentId()
            });
            if (!response?.success || !response.url) {
                throw new Error(response?.error || 'Could not open the Drive preview.');
            }
            location.assign(response.url);
        } catch (error) {
            showMessage(error.message || 'Could not open the Drive preview.');
        }
    }

    // Use an enabled native menu item as the color reference. The cloned
    // Download command is disabled and may inherit an intentionally dim color.
    function getMenuTextColor(downloadRow) {
        const menu = downloadRow.closest('#docs-file-menu, [role="menu"], .goog-menu, .apps-menu');
        const candidates = menu?.querySelectorAll('[role="menuitem"], .goog-menuitem, .apps-menuitem') || [];
        for (const row of candidates) {
            if (row === downloadRow || row.getAttribute('aria-disabled') === 'true' ||
                row.hasAttribute('disabled') || /disabled/i.test(row.className)) continue;
            const label = row.querySelector('.goog-menuitem-label') ||
                row.querySelector('.goog-menuitem-content') || row;
            const color = getComputedStyle(label).color;
            if (color && color !== 'transparent') return color;
        }
        return getComputedStyle(document.body).color;
    }

    function makeExportRow(downloadRow) {
        const item = downloadRow.cloneNode(true);
        // The Download row contains its own submenu arrow. Remove its DOM before cloning its behavior.
        item.querySelectorAll('[class*="submenu"], [class*="arrow"], [class*="caret"], .goog-menuitem-accel, [aria-haspopup], [data-submenu]')
            .forEach(element => element.remove());
        for (const node of [item, ...item.querySelectorAll('*')]) {
            for (const attribute of ['id', 'aria-disabled', 'aria-haspopup', 'aria-expanded',
                'aria-controls', 'aria-owns', 'jsaction', 'jsname', 'data-tooltip',
                'data-disabled', 'data-submenu', 'disabled']) {
                node.removeAttribute(attribute);
            }
            for (const className of [...node.classList]) {
                if (/disabled|highlight/.test(className) || SUBMENU_CLASS.test(className)) {
                    node.classList.remove(className);
                }
            }
        }
        item.id = MENU_ID;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', LABEL);
        // The Drive UI content script normally exposes the canonical icon.
        // Reuse it when available so Docs and Drive share the same artwork;
        // keep the native Download icon as a safe startup fallback if the
        // two content scripts are scheduled in the opposite order.
        const sharedIcon = window.__PSD?.ui?.downloadIconSvg;
        const iconHost = item.querySelector('.goog-menuitem-icon, .apps-menuitem-icon') ||
            item.querySelector('svg')?.parentElement;
        if (sharedIcon && iconHost) {
            iconHost.innerHTML = `<span aria-hidden="true">${sharedIcon}</span>`;
        }
        const label = item.querySelector('.goog-menuitem-label') ||
            item.querySelector('.goog-menuitem-content') || item;
        const nativeLabelStyle = getComputedStyle(label);
        const nativeRowStyle = getComputedStyle(downloadRow);
        const nativeRowHeight = downloadRow.getBoundingClientRect().height;
        // Two-line menu label, matching Drive's Export / app name treatment.
        // Keep the cloned native row's icon slot and spacing untouched.
        const primary = document.createElement('span');
        primary.className = 'dpe-docs-export-title';
        primary.textContent = 'Export';
        const secondary = document.createElement('span');
        secondary.className = 'dpe-docs-export-subtitle';
        secondary.textContent = 'Drive Preview Exporter';
        label.replaceChildren(primary, secondary);
        label.classList.add('dpe-docs-export-label');
        const color = getMenuTextColor(downloadRow);
        for (const element of [primary, secondary]) {
            element.style.fontFamily = nativeLabelStyle.fontFamily;
            element.style.fontWeight = nativeLabelStyle.fontWeight;
            element.style.letterSpacing = nativeLabelStyle.letterSpacing;
        }
        primary.style.fontSize = nativeLabelStyle.fontSize;
        primary.style.lineHeight = nativeLabelStyle.lineHeight;
        const titlePixels = Number.parseFloat(nativeLabelStyle.fontSize) || 14;
        secondary.style.fontSize = `${Math.max(10, Math.round(titlePixels * 0.78 * 10) / 10)}px`;
        secondary.style.lineHeight = `${Math.max(12, Math.round(titlePixels * 1.05 * 10) / 10)}px`;
        primary.style.color = color;
        primary.style.webkitTextFillColor = color;
        secondary.style.color = 'color-mix(in srgb, currentColor 68%, transparent)';
        secondary.style.webkitTextFillColor = 'color-mix(in srgb, currentColor 68%, transparent)';
        item.style.minHeight = '0';
        item.style.height = 'auto';
        item.style.cursor = 'pointer';
        item.style.opacity = '1';
        item.style.pointerEvents = 'auto';
        item.style.userSelect = 'none';
        // The original Download row is disabled and Google's native hover
        // handler does not necessarily recognize the cloned, enabled action.
        // Use the menu's enabled text color for a theme-aware hover fill.
        item.style.setProperty('color', color, 'important');
        item.style.setProperty('--dpe-docs-foreground', color);
        // The original Download icon is positioned for a one-line label.
        // Once we add a subtitle, center its native icon box on both lines
        // without changing its horizontal placement or SVG.
        requestAnimationFrame(() => {
            const paddingTop = Number.parseFloat(nativeRowStyle.paddingTop) || 0;
            const paddingBottom = Number.parseFloat(nativeRowStyle.paddingBottom) || 0;
            const labelHeight = label.getBoundingClientRect().height;
            item.style.minHeight = `${Math.ceil(Math.max(nativeRowHeight, labelHeight + paddingTop + paddingBottom))}px`;
            centerExportIcon(item);
        });
        item.addEventListener('click', activate, true);
        item.addEventListener('mousedown', event => event.stopImmediatePropagation(), true);
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event);
        }, true);
        return item;
    }

    function centerExportIcon(item) {
        if (!item.isConnected) return;
        const label = item.querySelector('.dpe-docs-export-label');
        const icon = item.querySelector('.goog-menuitem-icon, .apps-menuitem-icon');
        if (!label || !icon) return;

        // Reset our previous translation so repeated menu opens never drift.
        icon.style.removeProperty('translate');
        const labelBox = label.getBoundingClientRect();
        const iconBox = icon.getBoundingClientRect();
        if (!labelBox.height || !iconBox.height) return;
        const offset = (labelBox.top + labelBox.height / 2) -
            (iconBox.top + iconBox.height / 2);
        if (Number.isFinite(offset)) {
            icon.style.translate = `0 ${Math.round(offset * 10) / 10}px`;
        }
    }

    // Docs may draw the submenu arrow using a CSS pseudo-element instead of a DOM node.
    const style = document.createElement('style');
    style.textContent = `
        /* Explicit hover/focus behavior: Google doesn't manage a cloned
           menu item's hover class consistently. currentColor matches the
           enabled menu item in both light and dark themes. */
        #${MENU_ID}:hover,
        #${MENU_ID}:focus-visible,
        #${MENU_ID}.goog-menuitem-highlight {
            background-color: color-mix(in srgb, var(--dpe-docs-foreground, currentColor) 9%, transparent) !important;
            background-image: none !important;
        }
        #${MENU_ID}:focus-visible { outline: none !important; }
        #${MENU_ID}::after,
        #${MENU_ID} .goog-menuitem-content::after,
        #${MENU_ID} .goog-menuitem-label::after { content: none !important; display: none !important; }
        #${MENU_ID} [class*="submenu"], #${MENU_ID} [class*="arrow"],
        #${MENU_ID} [class*="caret"], #${MENU_ID} .goog-menuitem-accel { display: none !important; }
        #${MENU_ID} .goog-menuitem-icon,
        #${MENU_ID} .apps-menuitem-icon {
            opacity: 1 !important;
        }
        #${MENU_ID} .dpe-docs-export-label {
            display:flex !important; flex-direction:column !important;
            justify-content:center !important; align-items:flex-start !important;
            min-height:0 !important; box-sizing:border-box !important;
            white-space:nowrap !important;
            opacity:1 !important; -webkit-text-fill-color:initial !important;
        }
        #${MENU_ID} .dpe-docs-export-title {
            display:block !important; white-space:nowrap !important; opacity:1 !important;
        }
        #${MENU_ID} .dpe-docs-export-subtitle {
            display:block !important; margin-top:2px !important;
            white-space:nowrap !important; opacity:1 !important;
        }
    `;
    (document.head || document.documentElement).append(style);

    function scanFileMenu() {
        const menus = document.querySelectorAll(
            '#docs-file-menu, [role="menu"], .goog-menu, .apps-menu'
        );
        for (const menu of menus) {
            if (!isVisible(menu) || menu.querySelector(`#${MENU_ID}`)) continue;
            const row = findDownloadRow(menu);
            if (row) row.after(makeExportRow(row));
        }
    }

    // Docs can open an existing File menu by changing a class, without adding any DOM nodes.
    // A click/keyboard check also handles menus that become visible after our observer runs.
    let scanScheduled = false;
    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scanFileMenu();
        });
    }

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'aria-hidden', 'aria-expanded', 'hidden']
    });
    document.addEventListener('click', () => {
        scheduleScan();
        setTimeout(scanFileMenu, 100);
    }, true);
    document.addEventListener('keydown', scheduleScan, true);
    scanFileMenu();

    void chrome.runtime.sendMessage({ action: 'checkGoogleDocExport' }).then(result => {
        if (result?.redirected) {
            showMessage('This Google Doc reopened in Docs. Drive did not provide a capturable page preview, so PDF export could not start.');
        }
    }).catch(() => {});
})();
