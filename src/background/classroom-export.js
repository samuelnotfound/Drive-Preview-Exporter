// Each Classroom tab can have just one active export. The service worker keeps
// the last completed page signatures to reject retained blobs from a prior PDF.
const activeClassroomJobs = new Map();
const completedClassroomDocuments = new Map();
// A user can press Cancel before startClassroomPreviewExport reaches the
// service worker (e.g. while the content script resolves the file title).
const cancelledClassroomJobs = new Map();

// Start PDF capture inside the frame rendering a Classroom attachment.
// The Classroom File menu and preview pages can live in different frames.
async function startClassroomPreviewExport({ sender, request }) {
    const tabId = sender?.tab?.id;
    const source = (() => { try { return new URL(sender.url); } catch (_) { return null; } })();
    const tabUrl = (() => { try { return new URL(sender?.tab?.url); } catch (_) { return null; } })();
    const onClassroomTab = tabUrl?.hostname === 'classroom.google.com';
    const fromClassroom = source?.hostname === 'classroom.google.com';
    const fromEmbeddedViewer = onClassroomTab && source &&
        (source.hostname === 'drive.google.com' ||
         source.hostname.endsWith('.googleusercontent.com') ||
         source.hostname === 'docs.google.com');
    if ((!fromClassroom && !fromEmbeddedViewer) || !Number.isInteger(tabId)) {
        return { success: false, error: 'Open a document preview in Google Classroom first.' };
    }

    let filename = String(request?.filename || '').trim();
    const jobId = String(request?.jobId || `${Date.now()}-${Math.random()}`);
    if (cancelledClassroomJobs.get(tabId)?.id === jobId) {
        return { success: false, error: 'Export cancelled.' };
    }
    cancelledClassroomJobs.delete(tabId);
    const job = { id: jobId, cancelled: false, finished: false };
    activeClassroomJobs.set(tabId, job);
    const isCancelled = () => activeClassroomJobs.get(tabId) !== job || job.cancelled;
    const previousDocument = completedClassroomDocuments.get(tabId);
    const navigationPending = request?.navigationPending === true;
    const navigationFingerprints = Array.isArray(request?.navigationFingerprints)
        ? request.navigationFingerprints.slice(0, 300).map(value => String(value).slice(0, 2000))
        : null;

    // The attachment title belongs to the visible Classroom header, not to
    // the reused PDF iframe. Prefer a changed title over the last export's
    // title; otherwise allow a same-document re-download.
    try {
        const title = await chrome.tabs.sendMessage(tabId, {
            action: 'getStableClassroomPreviewTitle',
            previousFilename: previousDocument?.filename || '',
            preferNew: Boolean(previousDocument &&
                (navigationPending || filename !== previousDocument.filename))
        }, { frameId: 0 });
        if (isCancelled()) return { success: false, error: 'Export cancelled.' };
        const fresh = String(title?.filename || '').trim();
        if (fresh && (previousDocument || !filename)) filename = fresh;
        else if (navigationPending && previousDocument) filename = '';
    } catch (_) { /* A temporarily missing header must not prevent page discovery. */ }

    // The click can originate in a nested Drive frame. Put the visible status
    // card in Classroom's top frame before any title or renderer polling.
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'classroomExportProgressUpdate',
            status: 'Preparing export',
            detail: 'Finding the current preview…',
            filename,
            percent: 0, jobId
        }, { frameId: 0 });
    } catch (_) { /* The top frame can be navigating; the click frame still has its local card. */ }

    if (isCancelled()) return { success: false, error: 'Export cancelled.' };
    if (navigationPending) {
        // Make the renderer wait on the actual page transition, not the title
        // value that happened to be visible when Export was clicked.
        await setClassroomPreviewNavigation({ sender, request: {
            pending: true,
            ...(navigationFingerprints ? { fingerprints: navigationFingerprints } : {})
        } });
        try {
            const title = await chrome.tabs.sendMessage(tabId,
                { action: 'getStableClassroomPreviewTitle',
                  previousFilename: previousDocument?.filename || '', preferNew: true }, { frameId: 0 });
            if (title?.filename) filename = String(title.filename).trim();
        } catch (_) { /* Page fingerprints still guard the renderer if title lookup fails. */ }
    }

    // Classroom mounts the File menu before its page renderer and can move
    // that renderer into a sibling iframe. Give it time to appear.
    const maxAttempts = 32;
    const probeDiagnostics = new Map();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (isCancelled()) return { success: false, error: 'Export cancelled.' };
        if (attempt > 0 && attempt % 3 === 0) {
            try {
                const title = await chrome.tabs.sendMessage(tabId,
                    { action: 'getClassroomPreviewTitle' }, { frameId: 0 });
                if (title?.filename) filename = String(title.filename).trim();
            } catch (_) { /* The Classroom frame may be navigating. */ }
        }
        const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
        if (isCancelled()) return { success: false, error: 'Export cancelled.' };
        const byId = new Map(frames.map(frame => [frame.frameId, frame]));
        const candidates = [];
        for (const frame of frames) {
            try {
                const avoidFingerprints = previousDocument &&
                    (previousDocument.filename !== filename || navigationPending)
                    ? previousDocument.fingerprints : [];
                const reply = await chrome.tabs.sendMessage(tabId,
                    { action: 'probeClassroomPreviewPages', filename, avoidFingerprints },
                    { frameId: frame.frameId });
                if (reply?.diagnostic) probeDiagnostics.set(frame.frameId, reply.diagnostic);
                if (reply?.hasPages) {
                    const previous = new Set(avoidFingerprints);
                    const pages = Array.isArray(reply.fingerprints) ? reply.fingerprints : [];
                    // Exclude a renderer still showing only the last document.
                    // Probing itself must not wait for the capture guards.
                    const resolved = pages.filter(signature => signature !== 'unresolved-page');
                    const entirelyOld = previous.size > 0 && resolved.length > 0 &&
                        resolved.every(signature => previous.has(signature));
                    const mixedWithOld = previous.size > 0 && resolved.length > 0 &&
                        resolved.some(signature => previous.has(signature)) &&
                        resolved.some(signature => !previous.has(signature));
                    if (!entirelyOld && !mixedWithOld) candidates.push(frame.frameId);
                }
            } catch (_) { /* A frame may not yet have its content script. */ }
        }
        const isDescendant = frameId => {
            let frame = byId.get(frameId);
            const visited = new Set();
            while (frame && !visited.has(frame.frameId)) {
                visited.add(frame.frameId);
                if (frame.parentFrameId === sender.frameId) return true;
                frame = byId.get(frame.parentFrameId);
            }
            return false;
        };
        const descendants = candidates.filter(isDescendant);
        // The clicked viewer's own pages have priority. A single available
        // renderer is safe to use even if Classroom placed it in a sibling.
        const selected = candidates.includes(sender.frameId) ? sender.frameId
            : descendants.length === 1 ? descendants[0]
            : sender.frameId === 0 && candidates.length === 1 ? candidates[0]
            : null;
        if (selected !== null) {
            try {
                if (isCancelled()) return { success: false, error: 'Export cancelled.' };
                // Refresh the name from the live Classroom header, even when
                // the menu iframe supplied a non-empty but stale filename.
                try {
                    const header = await chrome.tabs.sendMessage(tabId,
                        { action: 'getClassroomPreviewTitle' }, { frameId: 0 });
                    const visibleTitle = String(header?.filename || '').trim();
                    if (visibleTitle && (!navigationPending ||
                        visibleTitle !== previousDocument?.filename) &&
                        (previousDocument || !filename)) filename = visibleTitle;
                } catch (_) {}
                // The File menu, document title, and rendered pages can each
                // reside in a different frame. Resolve the title per click.
                if (!filename) {
                    for (const frameId of [...new Set([0, sender.frameId, selected])]) {
                        try {
                            const title = await chrome.tabs.sendMessage(tabId,
                                { action: frameId === 0
                                    ? 'getStableClassroomPreviewTitle'
                                    : 'getClassroomPreviewTitle' }, { frameId });
                            if (title?.filename) { filename = title.filename; break; }
                        } catch (_) { /* Not every frame has the PDF content script. */ }
                    }
                }
                if (navigationPending) {
                    try {
                        const latest = await chrome.tabs.sendMessage(tabId,
                            { action: 'getClassroomPreviewTitle' }, { frameId: 0 });
                        const latestFilename = String(latest?.filename || '').trim();
                        if (latestFilename && latestFilename !== filename) {
                            filename = latestFilename;
                            continue;
                        }
                    } catch (_) { /* Keep the settled title and rely on page fingerprints. */ }
                }
                if (isCancelled()) return { success: false, error: 'Export cancelled.' };
                const avoidFingerprints = previousDocument &&
                    (previousDocument.filename !== filename || navigationPending)
                    ? previousDocument.fingerprints : [];
                const reply = await chrome.tabs.sendMessage(tabId,
                    {
                        action: 'captureClassroomPreviewPages', filename,
                        navigationPending, navigationFingerprints,
                        avoidFingerprints, jobId
                    }, { frameId: selected });
                if (isCancelled()) return { success: false, error: 'Export cancelled.' };
                if (reply?.success) return reply;
            } catch (_) { /* Iframe navigated. Retry probing the current tab. */ }
        }
        if (attempt < maxAttempts - 1) await new Promise(resolve => setTimeout(resolve, 300));
    }
    const inspected = [...probeDiagnostics.values()];
    const blobSurfaces = inspected.reduce((total, diagnostic) =>
        total + (diagnostic.surfaces || 0), 0);
    const largeSurfaces = inspected.reduce((total, diagnostic) =>
        total + (diagnostic.largeSurfaces || 0), 0);
    const reason = !inspected.length
        ? 'The extension could not inspect the embedded PDF frames.'
        : !blobSurfaces
        ? 'No PDF blob images or canvases were found in accessible frames.'
        : !largeSurfaces
        ? 'Images were found, but none had loaded at full page size.'
        : 'Page images were found, but the current document could not be verified.';
    console.warn('[Drive Preview Exporter] Classroom page discovery failed:',
        { reason, inspectedFrames: inspected.length, blobSurfaces, largeSurfaces });
    return { success: false, error: reason + ' Reopen the preview and try again.' };
}

function isClassroomExportUiMessage(sender) {
    let tabUrl, frameUrl;
    try {
        tabUrl = new URL(sender?.tab?.url);
        frameUrl = new URL(sender?.url);
    } catch (_) { return false; }
    return Number.isInteger(sender?.tab?.id) &&
        tabUrl.protocol === 'https:' && tabUrl.hostname === 'classroom.google.com' &&
        frameUrl.protocol === 'https:' &&
        (frameUrl.hostname === 'classroom.google.com' || frameUrl.hostname === 'drive.google.com' ||
         frameUrl.hostname.endsWith('.googleusercontent.com') || frameUrl.hostname === 'docs.google.com');
}

async function setClassroomPreviewNavigation({ sender, request }) {
    if (!isClassroomExportUiMessage(sender)) return { success: false };
    const pending = request?.pending !== false;
    const fingerprints = Array.isArray(request?.fingerprints)
        ? request.fingerprints.slice(0, 300).map(value => String(value).slice(0, 2000))
        : null;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id }) || [];
    const results = await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(sender.tab.id,
        {
            action: 'classroomPreviewNavigation', pending,
            ...(fingerprints && frame.frameId === sender.frameId ? { fingerprints } : {})
        }, { frameId: frame.frameId })));
    return { success: results.some(result => result.status === 'fulfilled') };
}

async function relayClassroomExportProgress({ sender, request }) {
    if (!isClassroomExportUiMessage(sender)) return { success: false };
    const tabId = sender.tab.id;
    const job = activeClassroomJobs.get(tabId);
    if (job && ((request.jobId && request.jobId !== job.id) || job.cancelled || job.finished)) {
        return { success: false, stale: true };
    }
    if (job && request.status === 'File exported') {
        job.finished = true;
        if (Array.isArray(request.fingerprints) && request.fingerprints.length) {
            completedClassroomDocuments.set(tabId, {
                filename: String(request.filename || '').trim(),
                fingerprints: request.fingerprints.slice(0, 300)
            });
        }
    } else if (job && ['Export cancelled', 'Capture incomplete', 'PDF conversion failed'].includes(request.status)) {
        job.finished = true;
    }
    try {
        await chrome.tabs.sendMessage(sender.tab.id, {
            action: 'classroomExportProgressUpdate',
            status: String(request?.status || '').slice(0, 80),
            detail: String(request?.detail || '').slice(0, 180),
            filename: String(request?.filename || '').slice(0, 180),
            percent: Number.isFinite(request?.percent) ? request.percent : null,
            jobId: job?.id || String(request.jobId || '')
        }, { frameId: 0 });
        return { success: true };
    } catch (_) {
        return { success: false };
    }
}

async function cancelClassroomPreviewExport({ sender, request }) {
    if (!isClassroomExportUiMessage(sender)) return { success: false };
    const tabId = sender.tab.id;
    const job = activeClassroomJobs.get(tabId);
    if (request?.jobId && job && request.jobId !== job.id) return { success: false };
    // Mark as cancelled before any asynchronous frame messages. A pending
    // scanner must never start capture after the user clicks Cancel.
    if (job) job.cancelled = true;
    const jobId = job?.id || String(request?.jobId || '');
    if (jobId) cancelledClassroomJobs.set(tabId, { id: jobId, at: Date.now() });
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'classroomExportProgressUpdate', status: 'Export cancelled',
            detail: '', jobId
        }, { frameId: 0 });
    } catch (_) {}
    const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
    await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(tabId,
        { action: 'cancelClassroomExportInFrame', jobId }, { frameId: frame.frameId })));
    return { success: true };
}

// A cross-origin Classroom attachment frame cannot read the top-level tab URL.
// Confirm the parent is Classroom before enabling menu injection in that frame.
function isClassroomPreviewTab({ sender }) {
    let tabUrl, frameUrl;
    try {
        tabUrl = new URL(sender?.tab?.url);
        frameUrl = new URL(sender?.url);
    } catch (_) { return { classroom: false }; }
    const allowedFrame = frameUrl.protocol === 'https:' &&
        /^(?:docs\.google\.com|(?:[\w-]+\.)?drive\.google\.com|[\w.-]+\.googleusercontent\.com)$/.test(frameUrl.hostname);
    return { classroom: tabUrl.protocol === 'https:' &&
        tabUrl.hostname === 'classroom.google.com' && allowedFrame };
}
