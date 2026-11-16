function driveDocumentBookmarklet(overlayHTML, scrollHTML, dimCSS) {

function documentPreviewAllowed() {
    var hostName = location.hostname;
    if (!/^(?:drive|docs|classroom)\.google\.com$/.test(hostName) && !/(?:^|\.)googleusercontent\.com$/.test(hostName)) return false;
    var metadata = {}, info = document.querySelector('#drive-active-item-info');
    try { metadata = JSON.parse(info && info.textContent || '{}'); } catch (_) {}
    var mime = String(metadata.mimeType || metadata.mime_type || '');
    var name = String(metadata.title || metadata.name || document.title || '').replace(/\s*[-–]\s*Google (?:Drive|Docs)\s*$/i, '');
    if (/^(?:video|audio)\//i.test(mime) || /\.(?:mp4|m4v|webm|mov|avi|mkv|flv|3gp|mp3|wav|m4a|ogg)\s*$/i.test(name)) return false;
    var player = document.querySelector('video,audio,iframe[src*="youtube" i]');
    if (player) { var rect = player.getBoundingClientRect(); if (rect.width && rect.height) return false; }
    if (/^(?:application\/pdf|application\/msword|application\/rtf|application\/vnd\.(?:google-apps\.(?:document|presentation)|openxmlformats-officedocument\.(?:wordprocessingml|presentationml)\.|oasis\.opendocument\.(?:text|presentation)))/i.test(mime)) return true;
    if (/\.(?:pdf|docx?|odt|rtf|pptx?)\s*$/i.test(name)) return true;
    if (hostName === 'docs.google.com' && /^\/(?:document|presentation|gview|viewer)(?:\/|$)/.test(location.pathname)) return true;
    return !!document.querySelector('[data-page-number],.kix-appview-editor,.punch-viewer-content');
}
if (!documentPreviewAllowed()) {
    alert('This bookmarklet works only on document previews. Use the extension to download videos.');
    return;
}
if (window.__dpeRunning) return; window.__dpeRunning = true; var MIN_W = 500, MIN_H = 300; var WAIT_FIRST = 12000, WAIT_IMG = 12000, ATTEMPTS = 4; var cancelled = false; var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }; function iw(e) { return e.naturalWidth || e.width || 0; } function ih(e) { return e.naturalHeight || e.height || 0; } function isSurface(e) { if (e.tagName === "CANVAS") return true; return e.tagName === "IMG" && [e.currentSrc, e.src].some(function (v) { return String(v || "").indexOf("blob:") !== -1; }); } function ready(e) { return (e.tagName === "CANVAS" || e.complete) && iw(e) >= MIN_W && ih(e) >= MIN_H; } function sameClasses(a, b) { if (a.tagName !== b.tagName || a.classList.length !== b.classList.length) return false; return Array.prototype.every.call(a.classList, function (n) { return b.classList.contains(n); }); } function pageImage(page) { var list = Array.prototype.filter.call(page.querySelectorAll("img, canvas"), function (e) { return isSurface(e) && ready(e); }); return list.length ? list[0] : null; } function getPages() { var all = document.querySelectorAll("img, canvas"); for (var i = 0; i < all.length; i++) { var e = all[i]; if (!isSurface(e) || !ready(e)) continue; var page = e.parentElement; var container = page && page.parentElement; if (!container) continue; var pages = Array.prototype.filter.call(container.children, function (c) { return sameClasses(page, c); }); if (pages.length) return pages; } return []; } async function waitFor(fn, timeout) { var end = Date.now() + timeout; while (Date.now() < end) { if (cancelled) throw new Error("Cancelled"); var v = fn(); if (v) return v; await sleep(100); } return fn(); } function toJpeg(img, quality) { var w = iw(img), h = ih(img); var c = document.createElement("canvas"); c.width = w; c.height = h; var ctx = c.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); return new Promise(function (res, rej) { c.toBlob(function (b) { c.width = c.height = 1; if (!b) return rej(new Error("JPEG encoding failed")); b.arrayBuffer().then(function (ab) { res({ bytes: new Uint8Array(ab), w: w, h: h }); }); }, "image/jpeg", quality); }); } function buildPdf(pages) { var enc = new TextEncoder(); var chunks = [], offs = [], len = 0; function push(d) { var b = typeof d === "string" ? enc.encode(d) : d; chunks.push(b); len += b.length; } function obj(n, body) { offs[n] = len; push(n + " 0 obj\n" + body + "\nendobj\n"); } var total = 2 + 3 * pages.length; push("%PDF-1.4\n"); obj(1, "<< /Type /Catalog /Pages 2 0 R >>"); var kids = pages.map(function (_, i) { return (3 + 3 * i) + " 0 R"; }).join(" "); obj(2, "<< /Type /Pages /Kids [" + kids + "] /Count " + pages.length + " >>"); pages.forEach(function (p, i) { var pg = 3 + 3 * i, im = pg + 1, ct = pg + 2; obj(pg, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w + " " + p.h + "] /Resources << /XObject << /Im" + (i + 1) + " " + im + " 0 R >> >> /Contents " + ct + " 0 R >>"); offs[im] = len; push(im + " 0 obj\n<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.bytes.length + " >>\nstream\n"); push(p.bytes); push("\nendstream\nendobj\n"); var content = "q\n" + p.w + " 0 0 " + p.h + " 0 0 cm\n/Im" + (i + 1) + " Do\nQ\n"; obj(ct, "<< /Length " + content.length + " >>\nstream\n" + content + "endstream"); }); var xref = len; var x = "xref\n0 " + (total + 1) + "\n0000000000 65535 f \n"; for (var n = 1; n <= total; n++) x += String(offs[n]).padStart(10, "0") + " 00000 n \n"; push(x + "trailer\n<< /Size " + (total + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF"); return new Blob(chunks, { type: "application/pdf" }); } function fileName() { var m = document.querySelector('meta[itemprop="name"]'); var t = (m && m.content) || document.title || "download.pdf"; t = t.replace(/\s*-\s*Google (Drive|Docs)\s*$/i, "").trim(); t = t.replace(/\.(?:docx?|odt|rtf|pptx?)$/i, ""); if (!/\.pdf$/i.test(t)) t += ".pdf"; return t.replace(/[<>:"\/\\|?*\x00-\x1F]/g, "_"); } function save(blob, name) { var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000); } function h(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; } var previous = document.getElementById('dpe-bookmarklet-overlay');
if (previous) previous.remove();
var host = h('div', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none');
host.id = 'dpe-bookmarklet-overlay';
var shadow = host.attachShadow({mode:'open'});
var dim = document.createElement('div');
dim.id = 'psd-scroll-dim';
dim.setAttribute('aria-hidden', 'true');
dim.style.cssText = dimCSS;
dim.style.display = 'block';
dim.innerHTML = scrollHTML;
shadow.appendChild(dim);
var overlay = document.createElement('div');
overlay.id = 'psd-inpage-overlay';
overlay.setAttribute('role', 'status');
overlay.setAttribute('aria-live', 'polite');
overlay.innerHTML = overlayHTML;
shadow.appendChild(overlay);
document.documentElement.appendChild(host);
var title = overlay.querySelector('#psd-inpage-title');
var detail = overlay.querySelector('#psd-inpage-detail');
var ring = overlay.querySelector('#psd-inpage-ring');
var cancel = overlay.querySelector('#psd-inpage-toggle');
var closeButton = overlay.querySelector('#psd-inpage-close');
function report(t, d, pct) {
    title.textContent = t === 'File exported' ? t : t === 'Capture incomplete' ? t : 'Preparing export';
    detail.textContent = d || '';
    if (pct != null) ring.style.strokeDashoffset = String(2 * Math.PI * 17 * (1 - Math.max(0, Math.min(100, pct)) / 100));
    if (t === 'File exported') { overlay.classList.add('completed'); dim.style.display = 'none'; }
    if (t === 'Capture incomplete') { overlay.classList.add('error'); dim.style.display = 'none'; }
}
function close() { host.remove(); window.__dpeRunning = false; }
cancel.onclick = function () {
    cancelled = true;
    dim.style.display = 'none';
    overlay.classList.add('cancelled');
    title.textContent = 'Export cancelled';
    detail.textContent = '';
    window.__dpeRunning = false;
};
closeButton.onclick = close;
report('Preparing export', 'Waiting for pages to load…', 0);
(async function main() { try { await waitFor(function () { return getPages().length; }, WAIT_FIRST); var pages = getPages(); if (!pages.length) throw new Error("Could not find rendered document pages. Open a PDF in the viewer first."); report("Capturing", "Found " + pages.length + " page" + (pages.length === 1 ? "" : "s"), 0); var out = []; for (var i = 0; i < pages.length; i++) { if (cancelled) return; report("Capturing", "Capturing page " + (i + 1) + " / " + pages.length, (i / pages.length) * 90); var last = null, got = null; for (var a = 0; a < ATTEMPTS && !got; a++) { try { var page = pages[i]; if (!page.isConnected) throw new Error("The page list changed during capture."); page.scrollIntoView({ block: "center" }); var img = await waitFor(function () { return pageImage(page); }, WAIT_IMG); if (!img) throw new Error("Timed out waiting for page " + (i + 1)); got = await toJpeg(img, 0.92); } catch (e) { last = e; if (e.message === "Cancelled") return; await sleep(200 * (a + 1)); } } if (!got) throw last || new Error("Could not capture page " + (i + 1)); out.push(got); } report("Processing", "Building PDF ...", 95); await sleep(30); if (cancelled) return; save(buildPdf(out), fileName()); report("File exported", out.length + " pages saved.", 100); cancel.textContent = "Close"; cancel.onclick = close; setTimeout(function () { if (host.isConnected) close(); }, 4000); } catch (e) { if (e.message === "Cancelled") return; report("Capture incomplete", e.message, 0); cancel.textContent = "Close"; cancel.onclick = close; } })(); 
}
