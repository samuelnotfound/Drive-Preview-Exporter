// One-time handoff between a Google Docs tab and its Drive preview.
// Chrome keeps the request scoped to the originating tab, including redirects.
const DOC_EXPORT_PREFIX = 'psdDocPdf:';
const DOC_EXPORT_TIMEOUT_MS = 90_000;
const docExportKey = tabId => `${DOC_EXPORT_PREFIX}${tabId}`;
const validDocId = value => /^[A-Za-z0-9_-]{10,200}$/.test(String(value || ''));

async function beginGoogleDocExport({ request, sender, tabId }) {
    const id = String(request.documentId || '');
    const source = (() => { try { return new URL(sender.url); } catch (_) { return null; } })();
    const sourceId = source?.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)?.[1];
    if (source?.hostname !== 'docs.google.com' || !validDocId(id) || sourceId !== id) {
        return { success: false, error: 'Not a valid Google Docs document.' };
    }
    await chrome.storage.session.set({
        [docExportKey(tabId)]: { documentId: id, startedAt: Date.now() }
    });
    const destination = new URL(`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`);
    // Keep the same signed-in Google account when the Docs URL specifies one.
    const account = source.pathname.match(/^\/document\/u\/(\d+)\//)?.[1] || source.searchParams.get('authuser');
    if (account && /^\d+$/.test(account)) destination.searchParams.set('authuser', account);
    return { success: true, url: destination.href };
}

async function readDocExport(tabId) {
    const key = docExportKey(tabId);
    const entry = (await chrome.storage.session.get(key))[key];
    if (!entry) return null;
    if (Date.now() - entry.startedAt > DOC_EXPORT_TIMEOUT_MS) {
        await chrome.storage.session.remove(key);
        return null;
    }
    return entry;
}

async function consumeGoogleDocExport({ request, sender, tabId }) {
    const url = (() => { try { return new URL(sender.url); } catch (_) { return null; } })();
    if (!url || url.hostname !== 'drive.google.com') return { success: false };
    const id = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)\/(?:view|preview)(?:\/|$)/)?.[1];
    const entry = await readDocExport(tabId);
    if (!entry || !id || id !== entry.documentId) return { success: false };
    return { success: true };
}

async function finishGoogleDocExport(ctx) {
    const result = await consumeGoogleDocExport(ctx);
    if (result.success) await chrome.storage.session.remove(docExportKey(ctx.tabId));
    return result;
}

async function checkGoogleDocExport({ request, sender, tabId }) {
    const url = (() => { try { return new URL(sender.url); } catch (_) { return null; } })();
    if (!url || url.hostname !== 'docs.google.com') return { success: false };
    const id = url.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/)?.[1];
    const entry = await readDocExport(tabId);
    if (!entry || !id || id !== entry.documentId) return { success: false };
    await chrome.storage.session.remove(docExportKey(tabId));
    return { success: true, redirected: true };
}
