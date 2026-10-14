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

    // Classroom mounts the File menu before its page renderer and can move
    // that renderer into a sibling iframe. Give it time to appear.
    for (let attempt = 0; attempt < 6; attempt++) {
        const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
        const byId = new Map(frames.map(frame => [frame.frameId, frame]));
        const candidates = [];
        for (const frame of frames) {
            try {
                const reply = await chrome.tabs.sendMessage(tabId,
                    { action: 'probeClassroomPreviewPages', filename: String(request?.filename || '').trim() },
                    { frameId: frame.frameId });
                if (reply?.hasPages) candidates.push(frame.frameId);
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
                // The File menu, document title, and rendered pages can each
                // reside in a different frame. Resolve the title per click.
                let filename = String(request?.filename || '').trim();
                if (!filename) {
                    for (const frameId of [...new Set([sender.frameId, 0, selected])]) {
                        try {
                            const title = await chrome.tabs.sendMessage(tabId,
                                { action: 'getClassroomPreviewTitle' }, { frameId });
                            if (title?.filename) { filename = title.filename; break; }
                        } catch (_) { /* Not every frame has the PDF content script. */ }
                    }
                }
                const reply = await chrome.tabs.sendMessage(tabId,
                    { action: 'captureClassroomPreviewPages', filename }, { frameId: selected });
                if (reply?.success) return reply;
            } catch (_) { /* Iframe navigated. Retry probing the current tab. */ }
        }
        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 350));
    }
    return { success: false, error: 'Could not find the current document pages. Try reopening the PDF.' };
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
