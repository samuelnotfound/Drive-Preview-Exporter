function driveDocumentBookmarklet(overlayTree, scrollTree, dimCSS) {
    var MIN_W = 500, MIN_H = 300;
    var WAIT_FIRST = 12000, WAIT_IMG = 12000, ATTEMPTS = 4;
    var cancelled = false;
    var sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

    function documentPreviewAllowed() {
        var hostName = location.hostname;
        if (!/^(?:drive|docs|classroom)\.google\.com$/.test(hostName) && !/(?:^|\.)googleusercontent\.com$/.test(hostName)) return false;
        var metadata = {}, info = document.querySelector('#drive-active-item-info');
        try { metadata = JSON.parse(info && info.textContent || '{}'); } catch (_) {}
        var mime = String(metadata.mimeType || metadata.mime_type || '');
        var nameMeta = document.querySelector('meta[itemprop="name"]');
        var name = String(metadata.title || metadata.name || (nameMeta && nameMeta.content) || document.title || '').replace(/\s*[-–]\s*Google (?:Drive|Docs)\s*$/i, '');
        if (/^(?:video|audio)\//i.test(mime) || /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|3gp|mp3|wav|m4a|ogg)\s*$/i.test(name)) return false;
        var player = document.querySelector('video,audio,iframe[src*="youtube" i]');
        if (player) {
            var rect = player.getBoundingClientRect();
            if (rect.width && rect.height) return false;
        }
        if (/^(?:application\/pdf|application\/msword|application\/rtf|application\/vnd\.(?:google-apps\.(?:document|presentation)|openxmlformats-officedocument\.(?:wordprocessingml|presentationml)\.|oasis\.opendocument\.(?:text|presentation)))/i.test(mime)) return true;
        if (/\.(?:pdf|docx?|odt|rtf|pptx?)\s*$/i.test(name)) return true;
        if (hostName === 'docs.google.com' && /^\/(?:document|presentation|gview|viewer)(?:\/|$)/.test(location.pathname)) return true;
        if (mime || /\.(?:png|jpe?g|gif|webp|svg|bmp)\s*$/i.test(name)) return false;
        return !!document.querySelector('[data-page-number],.kix-appview-editor,.punch-viewer-content') || getPages().length > 0;
    }

    function iw(element) { return element.naturalWidth || element.width || 0; }
    function ih(element) { return element.naturalHeight || element.height || 0; }

    function isSurface(element) {
        if (element.tagName === 'CANVAS') return true;
        return element.tagName === 'IMG' && [element.currentSrc, element.src].some(function (value) {
            return String(value || '').indexOf('blob:') !== -1;
        });
    }

    function ready(element) {
        return (element.tagName === 'CANVAS' || element.complete) && iw(element) >= MIN_W && ih(element) >= MIN_H;
    }

    function sameClasses(a, b) {
        if (a.tagName !== b.tagName || a.classList.length !== b.classList.length) return false;
        return Array.prototype.every.call(a.classList, function (name) { return b.classList.contains(name); });
    }

    function pageImage(page) {
        var images = Array.prototype.filter.call(page.querySelectorAll('img, canvas'), function (element) {
            return isSurface(element) && ready(element);
        });
        return images.length ? images[0] : null;
    }

    function getPages() {
        var all = document.querySelectorAll('img, canvas');
        for (var i = 0; i < all.length; i++) {
            var element = all[i];
            if (!isSurface(element) || !ready(element)) continue;
            var page = element.parentElement;
            var container = page && page.parentElement;
            if (!container) continue;
            var pages = Array.prototype.filter.call(container.children, function (child) { return sameClasses(page, child); });
            if (pages.length) return pages;
        }
        return [];
    }

    async function waitFor(fn, timeout) {
        var end = Date.now() + timeout;
        while (Date.now() < end) {
            if (cancelled) throw new Error('Cancelled');
            var value = fn();
            if (value) return value;
            await sleep(100);
        }
        return fn();
    }

    function toJpeg(image, quality) {
        var width = iw(image), height = ih(image);
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var context = canvas.getContext('2d', {alpha: false});
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                canvas.width = canvas.height = 1;
                if (!blob) return reject(new Error('JPEG encoding failed'));
                blob.arrayBuffer().then(function (buffer) {
                    resolve({bytes: new Uint8Array(buffer), w: width, h: height});
                }, reject);
            }, 'image/jpeg', quality);
        });
    }

    function buildPdf(pages) { var enc = new TextEncoder(); var chunks = [], offs = [], len = 0; function push(d) { var b = typeof d === "string" ? enc.encode(d) : d; chunks.push(b); len += b.length; }

function obj(n, body) { offs[n] = len; push(n + " 0 obj\n" + body + "\nendobj\n"); } var total = 2 + 3 * pages.length; push("%PDF-1.4\n"); obj(1, "<< /Type /Catalog /Pages 2 0 R >>"); var kids = pages.map(function (_, i) { return (3 + 3 * i) + " 0 R"; }).join(" "); obj(2, "<< /Type /Pages /Kids [" + kids + "] /Count " + pages.length + " >>"); pages.forEach(function (p, i) { var pg = 3 + 3 * i, im = pg + 1, ct = pg + 2; obj(pg, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w + " " + p.h + "] /Resources << /XObject << /Im" + (i + 1) + " " + im + " 0 R >> >> /Contents " + ct + " 0 R >>"); offs[im] = len; push(im + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.bytes.length + " >>\nstream\n"); push(p.bytes); push("\nendstream\nendobj\n"); var content = "q\n" + p.w + " 0 0 " + p.h + " 0 0 cm\n/Im" + (i + 1) + " Do\nQ\n"; obj(ct, "<< /Length " + content.length + " >>\nstream\n" + content + "endstream"); }); var xref = len; var x = "xref\n0 " + (total + 1) + "\n0000000000 65535 f \n"; for (var n = 1; n <= total; n++) x += String(offs[n]).padStart(10, "0") + " 00000 n \n"; push(x + "trailer\n<< /Size " + (total + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF"); return new Blob(chunks, { type: "application/pdf" }); }

    function fileName() {
        var metadata = document.querySelector('meta[itemprop="name"]');
        var name = (metadata && metadata.content) || document.title || 'download.pdf';
        name = name.replace(/\s*-\s*Google (Drive|Docs)\s*$/i, '').trim();
        name = name.replace(/\.(?:docx?|odt|rtf|pptx?)$/i, '');
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        return name.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_');
    }

    function save(blob, name) {
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }

    // The shared extension templates are compiled into data at build time.
    // Construct DOM nodes because Drive requires TrustedHTML for HTML strings.
    function appendNodes(parent, nodes, svg) {
        nodes.forEach(function (entry) {
            if (typeof entry === 'string') { parent.appendChild(document.createTextNode(entry)); return; }
            var isSvg = svg || entry[0] === 'svg';
            var element = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', entry[0]) : document.createElement(entry[0]);
            Object.keys(entry[1]).forEach(function (name) { element.setAttribute(name, entry[1][name]); });
            appendNodes(element, entry[2], isSvg);
            parent.appendChild(element);
        });
    }

    if (!documentPreviewAllowed()) {
        alert('This bookmarklet works only on document previews. Use the extension to download videos.');
        return;
    }

    // A failed setup can leave the legacy boolean set without a visible card.
    var previous = document.getElementById('dpe-bookmarklet-overlay');
    var existing = previous && previous.shadowRoot && previous.shadowRoot.querySelector('#psd-inpage-overlay');
    if (window.__dpeRunning && existing && !['completed', 'error', 'cancelled'].some(function (state) { return existing.classList.contains(state); })) return;
    var runToken = {};
    window.__dpeRunToken = runToken;
    window.__dpeRunning = true;

    function releaseRun() {
        // A cancelled run can finish after a new capture has already started.
        if (window.__dpeRunToken === runToken) {
            window.__dpeRunning = false;
            window.__dpeRunToken = null;
        }
    }

    var host, dim, overlay, title, detail, ring, cancel, closeButton;

    function report(text, description, percent) {
        title.textContent = text === 'File exported' || text === 'Capture incomplete' ? text : 'Preparing export';
        detail.textContent = description || '';
        if (percent != null) ring.style.strokeDashoffset = String(2 * Math.PI * 17 * (1 - Math.max(0, Math.min(100, percent)) / 100));
        if (text === 'File exported') { overlay.classList.add('completed'); dim.style.display = 'none'; }
        if (text === 'Capture incomplete') { overlay.classList.add('error'); dim.style.display = 'none'; }
    }

    function close() {
        cancelled = true;
        host.remove();
        releaseRun();
    }

    try {
        if (previous) previous.remove();
        host = document.createElement('div');
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
        host.id = 'dpe-bookmarklet-overlay';
        var shadow = host.attachShadow({mode: 'open'});
        dim = document.createElement('div');
        dim.id = 'psd-scroll-dim';
        dim.setAttribute('aria-hidden', 'true');
        dim.style.cssText = dimCSS;
        dim.style.display = 'block';
        appendNodes(dim, scrollTree, false);
        shadow.appendChild(dim);
        overlay = document.createElement('div');
        overlay.id = 'psd-inpage-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        appendNodes(overlay, overlayTree, false);
        shadow.appendChild(overlay);
        document.documentElement.appendChild(host);
        title = overlay.querySelector('#psd-inpage-title');
        detail = overlay.querySelector('#psd-inpage-detail');
        ring = overlay.querySelector('#psd-inpage-ring');
        cancel = overlay.querySelector('#psd-inpage-toggle');
        closeButton = overlay.querySelector('#psd-inpage-close');
        cancel.onclick = function () {
            cancelled = true;
            dim.style.display = 'none';
            overlay.classList.add('cancelled');
            title.textContent = 'Export cancelled';
            detail.textContent = '';
            releaseRun();
        };
        closeButton.onclick = close;
        report('Preparing export', 'Waiting for pages to load…', 0);
    } catch (error) {
        if (host) host.remove();
        releaseRun();
        alert('Could not start document download: ' + error.message);
        return;
    }

    (async function main() {
        try {
            await waitFor(function () { return getPages().length; }, WAIT_FIRST);
            if (cancelled) return;
            var pages = getPages();
            if (!pages.length) throw new Error('Could not find rendered document pages. Open a PDF in the viewer first.');
            report('Capturing', 'Found ' + pages.length + ' page' + (pages.length === 1 ? '' : 's'), 0);
            var out = [];
            for (var i = 0; i < pages.length; i++) {
                if (cancelled) return;
                report('Capturing', 'Capturing page ' + (i + 1) + ' / ' + pages.length, (i / pages.length) * 90);
                var last = null, got = null;
                for (var attempt = 0; attempt < ATTEMPTS && !got; attempt++) {
                    try {
                        var page = pages[i];
                        if (!page.isConnected) throw new Error('The page list changed during capture.');
                        page.scrollIntoView({block: 'center'});
                        var image = await waitFor(function () { return pageImage(page); }, WAIT_IMG);
                        if (!image) throw new Error('Timed out waiting for page ' + (i + 1));
                        got = await toJpeg(image, 0.92);
                    } catch (error) {
                        last = error;
                        if (cancelled || error.message === 'Cancelled') return;
                        await sleep(200 * (attempt + 1));
                    }
                }
                if (cancelled) return;
                if (!got) throw last || new Error('Could not capture page ' + (i + 1));
                out.push(got);
            }
            report('Processing', 'Building PDF ...', 95);
            await sleep(30);
            if (cancelled) return;
            save(buildPdf(out), fileName());
            report('File exported', out.length + ' pages saved.', 100);
            cancel.textContent = 'Close';
            cancel.onclick = close;
            setTimeout(function () { if (host.isConnected) close(); }, 4000);
        } catch (error) {
            if (cancelled || error.message === 'Cancelled') return;
            report('Capture incomplete', error.message, 0);
            cancel.textContent = 'Close';
            cancel.onclick = close;
        } finally {
            releaseRun();
        }
    })();
}
