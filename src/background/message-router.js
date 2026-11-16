// ============================================================================
// FILE: src/background/message-router.js
// PURPOSE: Central IPC (Inter-Process Communication) message router and action
//          dispatch table. Receives messages from content scripts, popup/overlays,
//          and the offscreen remuxer document; coordinates quality probing,
//          format harvesting, UI snapshots, and video download stages.
// ============================================================================

/** Storage key under chrome.storage for caching quality picker UI snapshots */
const PICKER_SNAPSHOT_KEY = 'psdQualityPickerSnapshots';

/** Standardized response factory for unauthorized or missing tab contexts */
const invalidTabResponse = () => ({ success: false, error: 'Invalid Drive tab.' });

/** Standardized response factory when a Drive file changes mid-operation */
const sessionChangedResponse = () => ({ success: false, error: 'The current Drive video session changed.' });

async function handlePrepareVideoPlayback({ tabId }) {
    try {
        // Start the hidden HTML loader on Export click so it is ready to check
        // stream URLs as soon as the Drive player exposes them.
        await ensureVideoOffscreen();
    } catch (error) {
        return { ok: false, error: `Could not start the background media checker: ${error?.message || String(error)}` };
    }
    const rows = await runQualityDom(tabId, 'prepareMutedPlayback');
    return rows.find(row => row?.value?.ok)?.value
        || rows.find(row => row?.value?.error)?.value
        || { ok: false, error: 'Could not find the Drive video player.' };
}

async function handleRestoreVideoPlayback({ tabId }) {
    await runQualityDom(tabId, 'restorePlayback');
    setTimeout(() => { void closeVideoOffscreen(); }, 1200);
    return { success: true };
}

/**
 * Higher-order middleware function ensuring a valid integer `tabId` exists in context.
 *
 * @param {Function} handler - Inner handler function
 * @param {Function} [unauthorizedResponse=invalidTabResponse] - Fallback response generator
 * @returns {Function}
 */
const requireDriveTab = (handler, unauthorizedResponse = invalidTabResponse) =>
    ctx => (Number.isInteger(ctx.tabId) ? handler(ctx) : unauthorizedResponse());

/**
 * Helper to fetch and validate the tab session for a specific Drive file ID.
 *
 * @param {number} tabId - Browser tab ID
 * @param {string} requestedFileId - Target Google Drive file ID
 * @returns {Promise<{session: Object, fileId: string}|null>} Session and resolved fileId or null
 */
async function getSessionForFile(tabId, requestedFileId) {
    const session = await getStoredSession(tabId);
    const fileId = String(requestedFileId || session?.fileId || '').trim();
    // Valid if session exists, fileId is non-empty, and matches session fileId
    const isCurrent = session && fileId && (!session.fileId || session.fileId === fileId);
    return isCurrent ? { session, fileId } : null;
}

// ============================================================================
// QUALITY PICKER UI SNAPSHOT STORAGE
// ============================================================================
// PURPOSE:
// Once the extension scans available qualities (e.g. 1080p, 720p, 360p) for a video,
// it saves a snapshot in storage. When the user re-opens the download modal,
// the options are displayed instantly from cache without re-opening Settings menu!
// ============================================================================

/**
 * Reads quality picker snapshots dictionary from a specified storage area.
 *
 * @param {chrome.storage.StorageArea} storageArea - session or local storage
 * @returns {Promise<Object>} Map of snapshots keyed by fileId
 */
async function readPickerSnapshots(storageArea) {
    const data = await storageArea.get(PICKER_SNAPSHOT_KEY);
    const snapshots = data?.[PICKER_SNAPSHOT_KEY];
    return snapshots && typeof snapshots === 'object' ? snapshots : {};
}

/**
 * Writes or updates a snapshot for a specific fileId.
 *
 * @param {chrome.storage.StorageArea} storageArea
 * @param {string} fileId
 * @param {Object} snapshot
 */
async function writePickerSnapshot(storageArea, fileId, snapshot) {
    const snapshots = await readPickerSnapshots(storageArea);
    snapshots[fileId] = snapshot;
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

/**
 * Deletes snapshot for a specific fileId.
 *
 * @param {chrome.storage.StorageArea} storageArea
 * @param {string} fileId
 */
async function deletePickerSnapshot(storageArea, fileId) {
    const snapshots = { ...await readPickerSnapshots(storageArea) };
    delete snapshots[fileId];
    await storageArea.set({ [PICKER_SNAPSHOT_KEY]: snapshots });
}

/**
 * Action: saveQualityPickerSnapshot
 * Persists quality options snapshot into session storage (falling back to local storage).
 */
async function handleSaveQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId || !request.snapshot?.formats) return { success: false, error: 'No quality snapshot.' };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try {
            await writePickerSnapshot(storageArea, fileId, request.snapshot);
            return { success: true };
        } catch (error) {
            if (storageArea === chrome.storage.local) return { success: false, error: error?.message || String(error) };
        }
    }
}

/**
 * Action: loadQualityPickerSnapshot
 * Reads cached quality options snapshot for a fileId.
 */
async function handleLoadQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: false, error: 'Missing file id.' };
    try {
        const snapshot = (await readPickerSnapshots(chrome.storage.session))[fileId] || null;
        if (snapshot) return { success: true, snapshot };
    } catch (_) {}
    try {
        return { success: true, snapshot: (await readPickerSnapshots(chrome.storage.local))[fileId] || null };
    } catch (error) {
        return { success: false, snapshot: null, error: error?.message || String(error) };
    }
}

/**
 * Action: clearQualityPickerSnapshot
 * Removes cached snapshot for a fileId from both storage areas.
 */
async function handleClearQualityPickerSnapshot({ request }) {
    const fileId = String(request.fileId || '').trim();
    if (!fileId) return { success: true };
    for (const storageArea of [chrome.storage.session, chrome.storage.local]) {
        try { await deletePickerSnapshot(storageArea, fileId); } catch (_) {}
    }
    return { success: true };
}

/**
 * Action: setVideoContext
 * Initializes or updates the active video session when content script binds to a Drive page.
 */
async function handleSetVideoContext({ request, tabId }) {
    const fileId = String(request.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();
    const filename = String(request.filename || '').trim();

    const current = await getStoredSession(tabId);
    const changed = !current
        || current.fileId !== fileId
        || current.viewerSessionId !== viewerSessionId
        || (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId);

    const next = changed
        ? emptySession(fileId, filename || 'gdrive-video', viewerSessionId)
        : {
            ...current,
            fileId: fileId || current.fileId,
            filename: filename || current.filename,
            viewerSessionId: viewerSessionId || current.viewerSessionId,
            pageBridgeId: pageBridgeId || current.pageBridgeId || ''
        };

    // Enable stream capture immediately for active viewer session
    next.streamCaptureEnabled = true;
    if (!changed && pageBridgeId) next.pageBridgeId = pageBridgeId;

    await setStoredSession(tabId, next);
    if (changed) setBadge('');
    return { success: true, changed, session: next };
}

/**
 * Action: updateFilename
 * Renames the file in the tab's active session.
 */
async function handleUpdateFilename({ request, tabId }) {
    const filename = String(request.filename || '').trim();
    await queueSessionMutation(tabId, session => {
        if (!filename || session.filename === filename) return false;
        session.filename = filename;
        return session;
    });
    return { success: true };
}

/**
 * Action: videoPlaybackIntent
 * Marks streamCaptureEnabled = true when user hovers or clicks play.
 */
async function handleVideoPlaybackIntent({ request, tabId }) {
    await queueSessionMutation(tabId, session => {
        if (request.fileId && session.fileId && request.fileId !== session.fileId) return false;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

/**
 * Action: videoPlaybackStarted
 * Sets playbackStarted = true and streamCaptureEnabled = true.
 */
async function handleVideoPlaybackStarted({ tabId }) {
    await queueSessionMutation(tabId, session => {
        if (session.playbackStarted) return false;
        session.playbackStarted = true;
        session.streamCaptureEnabled = true;
        return session;
    });
    return { success: true };
}

/**
 * Validates that an incoming page-bridge stream belongs to the active viewer session.
 */
function validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate }) {
    if (!session || !fileId || !viewerSessionId) return { success: false, error: 'No active Drive viewer session.' };
    if (session.fileId && fileId !== session.fileId) return { success: false, error: 'Drive file/session mismatch.' };
    if (session.viewerSessionId && viewerSessionId !== session.viewerSessionId) return { success: false, error: 'Drive viewer session mismatch.' };
    if (session.pageBridgeId && pageBridgeId && session.pageBridgeId !== pageBridgeId) return { success: false, error: 'Stale page bridge.' };
    const candidateFileId = String(candidate?.fileId || '').trim();
    if (candidateFileId && session.fileId && candidateFileId !== session.fileId) {
        return { success: false, error: 'Playback URL belongs to another Drive file.' };
    }
    return null;
}

/**
 * Helper to update format lists and current pointers when a stream is captured.
 */
function addCapturedStreamToSession(session, candidate, isAudio) {
    const kind = isAudio ? 'audio' : 'video';
    session[kind] = candidate.url;
    session[`${kind}Original`] = candidate.originalUrl;
    session[`${kind}Candidates`] = addUniqueCandidate(session[`${kind}Candidates`], candidate, 16);

    const format = {
        ...candidate,
        id: `captured:${candidate.itag || formatHash(candidate.url)}`,
        kind,
        acodec: isAudio ? candidate.codecs || '' : '',
        vcodec: isAudio ? '' : candidate.codecs || '',
        url: candidate.url,
        originalUrl: candidate.originalUrl
    };
    session.formats = {
        ...session.formats,
        [kind]: mergeFormatLists(session.formats?.[kind], [format], isAudio ? bySizeDesc : byHeightThenSize),
        [isAudio ? 'video' : 'audio']: session.formats?.[isAudio ? 'video' : 'audio'] || [],
        progressive: session.formats?.progressive || []
    };
}

/**
 * Action: pageStreamDetected
 * Receives stream detection messages from content script fetch/XHR hooks (network-bridge.js).
 */
async function handlePageStreamDetected({ request, tabId }) {
    const url = String(request.url || '').trim();
    if (!url || !url.includes('/videoplayback')) return { success: false, error: 'Not a Drive playback URL.' };

    const parsed = parseStreamCandidate(url, url);
    if (!parsed) return { success: false, error: 'Could not parse Drive playback URL.' };

    // Tag into the in-memory probe buffer FIRST (same as webRequest path)
    const state = streamCaptureState(tabId);
    const activeProbe = state.activeProbe;
    const candidate = {
        ...parsed,
        pageBridgeId: String(request.pageBridgeId || ''),
        frameUrl: String(request.frameUrl || ''),
        source: String(request.source || 'page-bridge'),
        capturedAt: Date.now()
    };
    if (activeProbe && Number(candidate.capturedAt) >= Number(activeProbe.startedAt || 0)) {
        tagCandidateWithProbe(candidate, activeProbe);
        addToProbeBuffer(state, candidate);
    }
    pushRecentStream(tabId, candidate);

    const session = await getStoredSession(tabId);
    const fileId = String(request.fileId || session?.fileId || '').trim();
    const viewerSessionId = String(request.viewerSessionId || session?.viewerSessionId || '').trim();
    const pageBridgeId = String(request.pageBridgeId || '').trim();

    const rejection = validatePageStream({ session, fileId, viewerSessionId, pageBridgeId, candidate: parsed });
    if (rejection) return rejection;

    candidate.pageBridgeId = pageBridgeId || session.pageBridgeId || '';

    let latest = null;
    await queueSessionMutation(tabId, current => {
        if (current.fileId !== session.fileId || current.viewerSessionId !== session.viewerSessionId) return false;
        if (pageBridgeId && current.pageBridgeId && current.pageBridgeId !== pageBridgeId) return false;
        if (!current.pageBridgeId && pageBridgeId) current.pageBridgeId = pageBridgeId;

        const probe = current.activeQualityProbe;
        if (probe) {
            tagCandidateWithProbe(candidate, probe);
            const limit = (typeof PROBE_BUFFER_LIMIT === 'number') ? PROBE_BUFFER_LIMIT : 48;
            current.probeCandidates = addUniqueCandidate(
                Array.isArray(current.probeCandidates) ? current.probeCandidates : [],
                candidate,
                limit
            );
        }

        const rawUrl = String(candidate.originalUrl || candidate.url || '');
        const isAudio = rawUrl.includes('mime=audio') || isAudioStream(candidate);
        if (isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('audio', candidate, rawUrl);
        } else if (!isAudio && typeof saveGlobalStream === 'function') {
            saveGlobalStream('video', candidate, rawUrl);
        }
        addCapturedStreamToSession(current, candidate, isAudio);
        current.playbackStarted = true;
        current.streamCaptureEnabled = true;
        latest = current;
        return current;
    });
    if (!latest) return { success: false, error: 'The current Drive viewer changed.' };

    setBadge('ON');
    await sendTab(tabId, {
        type: 'videoStreamDetected',
        fileId: latest.fileId,
        viewerSessionId: latest.viewerSessionId,
        stream: candidate,
        formats: latest.formats
    });
    return { success: true, session: latest, stream: candidate };
}

/**
 * Action: listPlayerQualityLabels
 * Opens the Drive video player's Settings -> Quality menu and reads all available resolution options.
 */
async function handleListPlayerQualityLabels({ request, tabId }) {
    const existing = QUALITY_SCAN_TAB_LOCK.get(tabId);
    if (existing?.promise) {
        return { success: false, error: 'Another quality operation is already running on this tab.', options: [] };
    }

    const work = (async () => {
        const found = await getSessionForFile(tabId, request.fileId);
        const fileId = String(found?.fileId || request.fileId || '').trim();

        // Localized string variants for Settings and Quality buttons
        const SETTINGS = ['settings', 'settings menu', 'player settings', 'video settings', 'open settings'];
        const QUALITY = ['quality', 'video quality', 'quality settings'];

        try {
            let options = [];
            let lastError = '';

            for (let attempt = 0; attempt < 2 && !options.length; attempt++) {
                await closePlayerMenu(tabId);
                await sleep(150 + attempt * 100);
                try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}

                // Open Settings menu
                const settings = await clickMenuLikeMini(tabId, SETTINGS, 'Settings', 5000, true);
                if (!settings?.ok) {
                    lastError = settings?.reason || 'Could not open Settings.';
                    continue;
                }
                await sleep(300);

                // Open Quality submenu
                const quality = await clickMenuLikeMini(
                    tabId, QUALITY, 'Quality', 5000, false,
                    Number.isInteger(settings.frameId) ? settings.frameId : null
                );
                if (!quality?.ok) {
                    lastError = quality?.reason || 'Could not open Quality menu.';
                    continue;
                }
                await sleep(300);

                // Scan quality options while submenu is visible
                const deadline = Date.now() + 4000;
                while (Date.now() < deadline) {
                    const rows = await runQualityDom(tabId, 'scanQualities');
                    const byHeight = new Map();
                    for (const row of rows || []) {
                        const value = row?.value;
                        const list = Array.isArray(value?.options) ? value.options
                            : Array.isArray(value) ? value
                            : [];
                        for (const opt of list) {
                            if (typeof opt === 'string') {
                                const h = Number(String(opt).match(/(\d{3,4})p/i)?.[1] || 0);
                                if (h) byHeight.set(h, { height: h, label: String(opt).trim(), selected: false });
                                continue;
                            }
                            const h = Number(opt?.height || 0);
                            if (!h) continue;
                            const lab = String(opt.text || opt.label || `${h}p`).trim();
                            const prev = byHeight.get(h);
                            if (!prev || opt.selected) byHeight.set(h, { height: h, label: lab, selected: !!opt.selected });
                        }
                        for (const lab of (value?.labels || [])) {
                            const h = Number(String(lab).match(/(\d{3,4})p/i)?.[1] || 0);
                            if (h && !byHeight.has(h)) {
                                byHeight.set(h, { height: h, label: String(lab).trim(), selected: false });
                            }
                        }
                    }
                    options = [...byHeight.values()].sort((a, b) => b.height - a.height);
                    if (options.length) break;
                    await sleep(120);
                }

                await closePlayerMenu(tabId);
                if (options.length) break;
                lastError = lastError || 'No quality options were found in the menu.';
            }

            if (!options.length) {
                try { await closePlayerMenu(tabId); } catch (_) {}
                return {
                    success: false,
                    error: lastError || 'No quality options were found in the menu.',
                    options: []
                };
            }

            return {
                success: true,
                fileId,
                options,
                formats: {
                    video: options.map(o => ({
                        id: `label:${o.height}`,
                        height: o.height,
                        qualityHeight: o.height,
                        probeQuality: o.label,
                        menuLabel: o.label,
                        labelOnly: true,
                        url: ''
                    })),
                    audio: [],
                    progressive: []
                }
            };
        } catch (error) {
            return { success: false, error: error?.message || 'Failed to list quality labels.', options: [] };
        }
    })();

    // Store in lock Map
    QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: work, finishedAt: 0 });
    try {
        return await work;
    } finally {
        QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: null, finishedAt: Date.now() });
    }
}

/**
 * Action: captureQualityForDownload
 * When user selects a quality in the UI:
 * 1. Simulates click on that quality in the player.
 * 2. Nudges playback to force segment requests.
 * 3. Waits for the video stream URL for that quality.
 * 4. Resolves shared audio track.
 * 5. Returns both streams ready for download.
 */
async function handleCaptureQualityForDownload({ request, tabId }) {
    const forceFresh = request.forceFresh === true;
    const height = Number(request.qualityHeight || request.height || 0);
    const label = String(request.qualityLabel || request.label || (height ? `${height}p` : '')).trim();
    if (!height) return { success: false, error: 'No quality selected.' };
    const found = await getSessionForFile(tabId, request.fileId);
    if (!found) return sessionChangedResponse();
    const { fileId } = found;
    const viewerSessionId = found.session.viewerSessionId || '';
    const isCurrentSession = session => session && session.fileId === fileId &&
        String(session.viewerSessionId || '') === viewerSessionId;
    if (QUALITY_SCAN_TAB_LOCK.get(tabId)?.promise) {
        return { success: false, error: 'Another quality capture is already running.' };
    }

    const work = (async () => {
        let probe;
        try {
            await closePlayerMenu(tabId);
            await sleep(120);
            try { await runQualityDom(tabId, 'revealControls'); } catch (_) {}
            await sleep(100);
            if (!isCurrentSession(await getStoredSession(tabId))) return sessionChangedResponse();

            // Install the probe before clicking: the player can request the new
            // resolution immediately, while the click animation is still running.
            probe = await beginQualityProbe(tabId, fileId, label || `${height}p`);
            if (!probe || probe.accepted === false) return sessionChangedResponse();
            const clickAt = Date.now();
            const selected = await selectQualityVerified(tabId, label || `${height}p`, height, 8000, null);
            if (!selected?.ok) return { success: false, error: `Could not find ${label || height + 'p'} in the quality menu.` };
            const playback = await runQualityDom(tabId, 'prepareMutedPlayback');
            if (!playback.some(row => row?.value?.ok)) {
                return { success: false, error: playback.find(row => row?.value?.error)?.value?.error || 'Could not start the muted preview.' };
            }
            try { await nudgePlaybackAfterQualitySwitch(tabId); } catch (_) {}

            let video = await waitForQualityStream(tabId, probe.token, height, 6000, new Set(), clickAt);
            if (!video?.url) {
                try { await nudgePlaybackAfterQualitySwitch(tabId); } catch (_) {}
                video = await waitForQualityStream(tabId, probe.token, height, 4000, new Set(), clickAt);
            }
            // Re-selecting an already buffered quality may not make a new request.
            // Only independently identified, matching cached streams are eligible.
            if (!forceFresh && !video?.url) {
                video = (streamCaptureState(tabId)?.recentStreams || [])
                    .filter(stream => matchesQualityStream(stream, height))
                    .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0))[0] || null;
            }
            if (!video?.url) return {
                success: false,
                error: `${label || height + 'p'} did not produce a matching video stream. Play or seek the video, then try Download again.`
            };
            if (!isCurrentSession(await getStoredSession(tabId))) return sessionChangedResponse();
            video = {
                ...video, height, qualityHeight: height, probeQuality: label,
                url: cleanURL(video.originalUrl || video.url) || video.url,
                originalUrl: video.originalUrl || video.url
            };

            // Changing video resolution often reuses buffered audio. Keep audio
            // scoped to this viewer; a global fallback may belong to another tab.
            const recentAudio = (streamCaptureState(tabId)?.recentStreams || [])
                .filter(stream => stream?.url && isAudioStream(stream))
                .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0));
            let audio = recentAudio[0] || await getCurrentSessionAudioCandidate(tabId);
            if (audio?.url) audio = {
                ...audio, url: cleanURL(audio.originalUrl || audio.url) || audio.url,
                originalUrl: audio.originalUrl || audio.url
            };

            let saved = false;
            await queueSessionMutation(tabId, current => {
                if (!isCurrentSession(current)) return false;
                current.formats = current.formats || { video: [], audio: [], progressive: [] };
                current.formats.video = mergeFormatLists(current.formats.video || [], [video], byHeightWidthThenSize, 48);
                if (audio?.url) {
                    current.formats.audio = [audio];
                    current.audio = audio.url;
                    current.audioOriginal = audio.originalUrl;
                }
                current.video = video.url;
                current.videoOriginal = video.originalUrl;
                current.videoCandidates = addUniqueCandidate(current.videoCandidates || [], video, 24);
                current.streamCaptureEnabled = true;
                saved = true;
                return current;
            });
            if (!saved) return sessionChangedResponse();

            const streamsToCheck = [{
                label: 'video',
                url: video.originalUrl || video.url,
                total: Number(video.contentLength) || getStreamBytes(video.originalUrl || video.url)
            }];
            if (audio?.url) streamsToCheck.push({
                label: 'audio',
                url: audio.originalUrl || audio.url,
                total: Number(audio.contentLength) || getStreamBytes(audio.originalUrl || audio.url)
            });
            const preflight = await preflightCapturedStreams(streamsToCheck);
            if (!preflight?.success) {
                return { success: false, error: `Background media URL check failed: ${preflight?.error || 'the stream is not available.'}` };
            }

            return { success: true, video, audio: audio?.url ? audio : null, height, label };
        } finally {
            if (probe?.token) try { await endQualityProbe(tabId, probe.token); } catch (_) {}
            try { await closePlayerMenu(tabId); } catch (_) {}
            try { await runQualityDom(tabId, 'restorePlayback'); } catch (_) {}
        }
    })();
    QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: work, finishedAt: 0 });
    try { return await work; }
    finally {
        if (QUALITY_SCAN_TAB_LOCK.get(tabId)?.promise === work) {
            QUALITY_SCAN_TAB_LOCK.set(tabId, { promise: null, finishedAt: Date.now() });
        }
    }
}

/**
 * Action: clearTabCaptureState
 * Wipes capture state for a tab upon request.
 */
async function handleClearTabCaptureState({ tabId }) {
    if (!Number.isInteger(tabId) || tabId < 0) return { success: false };
    try {
        if (typeof clearTabMediaState === 'function') {
            await clearTabMediaState(tabId, { clearGlobal: true });
        } else {
            await clearStoredSession(tabId);
            clearStreamCaptureState(tabId);
            try {
                if (typeof GLOBAL_LAST_AUDIO !== 'undefined') GLOBAL_LAST_AUDIO = null;
                if (typeof GLOBAL_LAST_VIDEO !== 'undefined') GLOBAL_LAST_VIDEO = null;
            } catch (_) {}
            try { await chrome.storage.local.remove(['psdGlobalStreams']); } catch (_) {}
        }
    } catch (_) {}
    return { success: true };
}

/**
 * Action: getStreams
 * Aggregates all discovered streams and formats for the tab, merging recent captures.
 */
const handleGetStreams = async ({ tabId }) => {
    if (typeof loadGlobalStreamsFromStorage === 'function') {
        await loadGlobalStreamsFromStorage();
    }

    let session = Number.isInteger(tabId) ? await getStoredSession(tabId) : null;
    const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    const globalVideo = typeof getGlobalLastVideo === 'function' ? getGlobalLastVideo() : null;
    const recent = (Number.isInteger(tabId) && typeof streamCaptureState === 'function')
        ? (streamCaptureState(tabId)?.recentStreams || [])
        : [];

    const recentVideo = recent.filter(s => s?.url && !isAudioStream(s));
    const recentAudio = recent.filter(s => s?.url && isAudioStream(s));

    if (!session) {
        session = {
            fileId: '',
            filename: '',
            formats: { video: [], audio: [], progressive: [] },
            videoCandidates: [],
            audioCandidates: [],
            streamCaptureEnabled: true
        };
    }
    session.formats = session.formats || { video: [], audio: [], progressive: [] };
    session.videoCandidates = Array.isArray(session.videoCandidates) ? session.videoCandidates : [];
    session.audioCandidates = Array.isArray(session.audioCandidates) ? session.audioCandidates : [];

    // Merge recent video captures
    for (const stream of recentVideo) {
        session.videoCandidates = addUniqueCandidate(session.videoCandidates, stream, 24);
        if (isMuxedStream(stream)) {
            session.formats.progressive = mergeFormatLists(
                session.formats.progressive || [],
                [{ ...stream, progressive: true }],
                byHeightWidthThenSize,
                24
            );
        } else {
            session.formats.video = mergeFormatLists(
                session.formats.video || [],
                [stream],
                byHeightWidthThenSize,
                48
            );
        }
        if (!session.video) {
            session.video = stream.url;
            session.videoOriginal = stream.originalUrl || stream.url;
        }
    }

    // Merge global fallback video
    if (globalVideo?.url && !(session.formats.video || []).length && !(session.formats.progressive || []).length) {
        session.videoCandidates = addUniqueCandidate(session.videoCandidates, globalVideo, 24);
        session.formats.video = mergeFormatLists(session.formats.video || [], [globalVideo], byHeightWidthThenSize, 48);
        session.video = globalVideo.url;
        session.videoOriginal = globalVideo.originalUrl || globalVideo.url;
    }

    // Merge recent audio captures
    for (const stream of recentAudio) {
        session.audioCandidates = addUniqueCandidate(session.audioCandidates, stream, 8);
        if (!session.audio) {
            session.audio = stream.url;
            session.audioOriginal = stream.originalUrl || stream.url;
        }
    }
    if (!session.audio && globalAudio?.url) {
        session.audio = globalAudio.url;
        session.audioOriginal = globalAudio.originalUrl || globalAudio.url;
        session.audioCandidates = addUniqueCandidate(session.audioCandidates, globalAudio, 8);
    }
    if (session.audio) {
        const a = session.audioCandidates[0] || globalAudio || recentAudio[0] || {
            url: session.audio,
            originalUrl: session.audioOriginal || session.audio,
            mime: 'audio/mp4'
        };
        session.formats.audio = [{
            ...a,
            url: cleanURL(a.originalUrl || a.url) || a.url,
            originalUrl: a.originalUrl || a.url,
            id: a.id || `audio:${a.itag || ''}`
        }];
    }

    // Persist merged state into storage
    if (Number.isInteger(tabId) && tabId >= 0 && (session.fileId || session.video || session.audio)) {
        try {
            const existing = await getStoredSession(tabId);
            if (existing) {
                await queueSessionMutation(tabId, current => {
                    if (!current) return false;
                    current.video = current.video || session.video;
                    current.videoOriginal = current.videoOriginal || session.videoOriginal;
                    current.audio = current.audio || session.audio;
                    current.audioOriginal = current.audioOriginal || session.audioOriginal;
                    current.videoCandidates = mergeFormatLists(
                        current.videoCandidates || [], session.videoCandidates || [], byHeightWidthThenSize, 48
                    );
                    current.audioCandidates = addUniqueCandidate(
                        current.audioCandidates || [], session.audioCandidates?.[0], 8
                    );
                    current.formats = current.formats || { video: [], audio: [], progressive: [] };
                    current.formats.video = mergeFormatLists(
                        current.formats.video || [], session.formats.video || [], byHeightWidthThenSize, 48
                    );
                    current.formats.audio = (current.formats.audio?.length ? current.formats.audio : session.formats.audio) || [];
                    current.formats.progressive = mergeFormatLists(
                        current.formats.progressive || [], session.formats.progressive || [], byHeightWidthThenSize, 24
                    );
                    current.streamCaptureEnabled = true;
                    return current;
                });
                session = await getStoredSession(tabId) || session;
            }
        } catch (_) {}
    }

    return {
        streams: session,
        globalAudio: session.formats?.audio?.[0] || globalAudio || null,
        globalVideo: (session.formats?.video || [])[0] || globalVideo || null,
        recentCount: recent.length
    };
};

/**
 * Action: downloadVideo
 * Initiates the video download process.
 */
const handleDownloadVideo = ({ request, tabId }) => startVideoDownload(tabId, request || {});

/** Start a queued job only after the caller has mounted its progress overlay. */
async function handleActivateVideoStage({ request, tabId }) {
    const jobId = String(request.jobId || '');
    const job = (await getStoredJobs())[jobId];
    if (!job || job.sourceTabId !== tabId) {
        return { success: false, error: 'This video download is no longer active.' };
    }

    try {
        // Retry delivery once if Chrome closed the offscreen page between
        // creation and sending. Each job ID is guarded against duplicate runs.
        let error = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await ensureVideoOffscreen();
                let timeout;
                let result;
                try {
                    result = await Promise.race([
                        chrome.runtime.sendMessage({ target: 'video-offscreen', type: 'videoStageStart', jobId }),
                        new Promise((_, reject) => {
                            timeout = setTimeout(() => reject(new Error('Downloader did not respond.')), 5000);
                        })
                    ]);
                } finally {
                    clearTimeout(timeout);
                }
                if (result?.accepted) return { success: true, jobId };
                throw new Error('Downloader did not accept the job.');
            } catch (caught) {
                error = caught;
            }
        }
        throw error;
    } catch (error) {
        await removeVideoStageJob(jobId);
        return { success: false, error: error?.message || String(error) };
    }
}

/**
 * Type: getVideoStageJob
 * Retrieves staging job metadata requested by offscreen downloader.
 */
async function handleGetVideoStageJob({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    return job ? { success: true, job } : { success: false, error: 'Staging job not found.' };
}

/** Chrome's downloads API saves OPFS-backed Files without creating a giant RAM buffer. */
const PENDING_SAVES_KEY = 'gdrivePendingDiskSaves';
let pendingSaveLock = Promise.resolve();

function editPendingSaves(change) {
    const next = pendingSaveLock.then(async () => {
        const saved = await chrome.storage.local.get(PENDING_SAVES_KEY);
        const pending = saved[PENDING_SAVES_KEY] || {};
        const result = change(pending);
        await chrome.storage.local.set({ [PENDING_SAVES_KEY]: pending });
        return result;
    });
    pendingSaveLock = next.catch(() => {});
    return next;
}

async function settleVideoSave(downloadId, state, errorMessage = '') {
    const item = await editPendingSaves(pending => {
        const key = String(downloadId);
        const value = pending[key];
        delete pending[key];
        return value;
    });
    if (!item) return;
    sendOffscreen({ type: 'videoStageSaveCompleteInternal', jobId: item.jobId });
    await handleVideoStageMessage({ request: {
        type: state === 'complete' ? 'videoStageFinished' : 'videoStageError',
        jobId: item.jobId,
        message: errorMessage || 'Chrome could not save the MP4 file.'
    }});
}

chrome.downloads.onChanged.addListener(delta => {
    if (!delta.state?.current || !['complete', 'interrupted'].includes(delta.state.current)) return;
    void settleVideoSave(delta.id, delta.state.current, delta.error?.current).catch(() => {});
});

async function startDiskBackedSave(request) {
    const job = (await getStoredJobs())[request.jobId];
    if (!job) return { success: false, error: 'Download was cancelled.' };
    const url = String(request.url || '');
    if (!url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) {
        return { success: false, error: 'Invalid extension download URL.' };
    }
    // Use the job's stored filename, not a filename supplied in a runtime message.
    const id = await chrome.downloads.download({
        url,
        filename: String(job.filename || 'video.mp4').replace(/[\\:*?"<>|]/g, '_'),
        conflictAction: 'uniquify', saveAs: false
    });
    if (!Number.isInteger(id)) return { success: false, error: 'Chrome did not accept the download.' };
    await editPendingSaves(pending => { pending[String(id)] = { jobId: request.jobId }; });
    // A very small download can finish before the pending record is written.
    const [existing] = await chrome.downloads.search({ id });
    if (existing?.state === 'complete' || existing?.state === 'interrupted') {
        void settleVideoSave(id, existing.state, existing.error).catch(() => {});
    }
    return { success: true, downloadId: id };
}

/** Set of terminal stage job event types */
const FINISHED_STAGE_TYPES = new Set(['videoStageFinished', 'videoStageError', 'videoStageCancelled']);

/**
 * Cancels an active video download staging job.
 *
 * @param {string} jobId - Job ID
 * @param {Object} job - Stored job object
 * @param {Object} [options]
 * @param {boolean} [options.silent=false] - If true, do not send cancellation event to tab
 */
async function cancelVideoStage(jobId, job, options = {}) {
    sendOffscreen({ type: 'videoStageCancelInternal', jobId });
    const pending = (await chrome.storage.local.get(PENDING_SAVES_KEY))[PENDING_SAVES_KEY] || {};
    for (const [id, save] of Object.entries(pending)) {
        if (save.jobId === jobId) await chrome.downloads.cancel(Number(id)).catch(() => {});
    }
    if (!options.silent && job?.sourceTabId != null) {
        await sendTab(job.sourceTabId, { type: 'videoStageCancelled', jobId });
    }
    await removeVideoStageJob(jobId);
    // Schedule check to close offscreen document
    setTimeout(closeVideoOffscreen, 100);
    return { success: true };
}

/**
 * Restarts a stuck download job without losing progress.
 *
 * The job record (stream URLs, sizes) lives in storage, so this works even if
 * the offscreen document was closed/recreated while the download was stalled.
 * The offscreen side decides whether to resume the live run or start over.
 *
 * @param {string} jobId - Job ID
 */
async function restartVideoStage(jobId) {
    const job = (await getStoredJobs())[jobId];
    if (!job) return { success: false, error: 'This download is no longer active.' };
    try {
        await ensureVideoOffscreen();
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
    sendOffscreen({ type: 'videoStageRestartInternal', jobId });
    return { success: true };
}

/**
 * Relays progress and lifecycle messages from offscreen chunk downloader to tab UI.
 */
async function handleVideoStageMessage({ request }) {
    const job = (await getStoredJobs())[request.jobId];
    const isCancel = request.type === 'videoStageCancel';

    // Restart comes from the tab's overlay; it is a command, not a status to relay back.
    if (request.type === 'videoStageRestart') return restartVideoStage(request.jobId);
    if (request.type === 'videoStageSaveReady') return startDiskBackedSave(request);

    // Forward progress/status message to originating tab UI
    if (job?.sourceTabId != null && !isCancel) await sendTab(job.sourceTabId, { type: request.type, ...request });
    if (isCancel) return cancelVideoStage(request.jobId, job);

    // If job finished, errored, or cancelled, clean up resources
    if (FINISHED_STAGE_TYPES.has(request.type)) {
        await queueJobMutation(currentJobs => {
            if (!currentJobs[request.jobId]) return false;
            delete currentJobs[request.jobId];
            return true;
        });
        setTimeout(closeVideoOffscreen, 1200);
    }
    return { success: true };
}

/**
 * Map of actions keyed by `request.action`.
 */
const ACTION_HANDLERS = Object.freeze({
    beginGoogleDocExport: requireDriveTab(beginGoogleDocExport),
    startClassroomPreviewExport: requireDriveTab(startClassroomPreviewExport),
    classroomExportProgress: requireDriveTab(relayClassroomExportProgress),
    classroomPreviewNavigation: requireDriveTab(setClassroomPreviewNavigation),
    cancelClassroomPreviewExport: requireDriveTab(cancelClassroomPreviewExport),
    isClassroomPreviewTab: requireDriveTab(isClassroomPreviewTab),
    consumeGoogleDocExport: requireDriveTab(consumeGoogleDocExport),
    finishGoogleDocExport: requireDriveTab(finishGoogleDocExport),
    checkGoogleDocExport: requireDriveTab(checkGoogleDocExport),
    saveQualityPickerSnapshot: requireDriveTab(handleSaveQualityPickerSnapshot),
    loadQualityPickerSnapshot: requireDriveTab(handleLoadQualityPickerSnapshot),
    clearQualityPickerSnapshot: requireDriveTab(handleClearQualityPickerSnapshot),
    setVideoContext: requireDriveTab(handleSetVideoContext),
    updateFilename: requireDriveTab(handleUpdateFilename),
    pageStreamDetected: requireDriveTab(handlePageStreamDetected),
    videoPlaybackIntent: requireDriveTab(handleVideoPlaybackIntent, () => ({ success: false })),
    videoPlaybackStarted: requireDriveTab(handleVideoPlaybackStarted, () => ({ success: false })),
    listPlayerQualityLabels: requireDriveTab(handleListPlayerQualityLabels),
    prepareVideoPlayback: requireDriveTab(handlePrepareVideoPlayback),
    restoreVideoPlayback: requireDriveTab(handleRestoreVideoPlayback),
    captureQualityForDownload: requireDriveTab(handleCaptureQualityForDownload),
    clearTabCaptureState: requireDriveTab(handleClearTabCaptureState),
    getStreams: handleGetStreams,
    downloadVideo: handleDownloadVideo,
    activateVideoStage: requireDriveTab(handleActivateVideoStage)
});

/**
 * Map of handlers keyed by `request.type`.
 */
const TYPE_HANDLERS = Object.freeze({
    getVideoStageJob: handleGetVideoStageJob,
    refreshVideoStageStreams
});

/**
 * Central runtime message dispatcher.
 * Resolves target tabId from request or sender and routes to matching handler.
 *
 * @param {Object} request - Incoming JSON payload
 * @param {Object} sender - Sender metadata from Chrome
 * @returns {Promise<*>}
 */
async function handleRuntimeMessage(request = {}, sender = {}) {
    const tabId = Number.isInteger(request.tabId) ? request.tabId : sender?.tab?.id;
    const ctx = { request, sender, tabId };

    // 1. Check action-based handlers
    const actionHandler = ACTION_HANDLERS[String(request.action || '')];
    if (actionHandler) return actionHandler(ctx);

    // 2. Check type-based handlers
    const type = String(request.type || '');
    const typeHandler = TYPE_HANDLERS[type];
    if (typeHandler) return typeHandler(ctx);

    // 3. Check video stage messages (progress, cancel, finish) from offscreen
    if (type.startsWith('videoStage')) return handleVideoStageMessage(ctx);

    return undefined;
}

/**
 * Root Chrome Extension message listener.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // These commands are for the offscreen document. Do not reply from the
    // service worker: otherwise Chrome may resolve the message with an empty
    // response before the actual downloader accepts it.
    if (request?.target === 'video-offscreen') return false;
    handleRuntimeMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: error?.message || String(error) }));
    return true; // Keep message channel open for async response
});
