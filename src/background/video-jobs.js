// ============================================================================
// FILE: src/background/video-jobs.js
// PURPOSE: Resolve selected streams, create a download job, open the offscreen
//          document, and start disk-backed stream downloads and MP4 remuxing.
// ============================================================================

let offscreenLock = Promise.resolve();
let offscreenGeneration = 0;
const BACKGROUND_CAPTURE_STORAGE_KEY = 'psdBackgroundCaptureTabs';
const BACKGROUND_CAPTURE_TABS = new Map();

async function readBackgroundCaptureEntry(sourceTabId) {
    const key = String(sourceTabId);
    if (BACKGROUND_CAPTURE_TABS.has(key)) return BACKGROUND_CAPTURE_TABS.get(key);
    try {
        const saved = await chrome.storage.session.get(BACKGROUND_CAPTURE_STORAGE_KEY);
        const entry = saved?.[BACKGROUND_CAPTURE_STORAGE_KEY]?.[key] || null;
        if (entry) BACKGROUND_CAPTURE_TABS.set(key, entry);
        return entry;
    } catch (_) { return null; }
}

async function writeBackgroundCaptureEntry(sourceTabId, entry) {
    const key = String(sourceTabId);
    BACKGROUND_CAPTURE_TABS.set(key, entry);
    try {
        const saved = await chrome.storage.session.get(BACKGROUND_CAPTURE_STORAGE_KEY);
        const entries = saved?.[BACKGROUND_CAPTURE_STORAGE_KEY] || {};
        entries[key] = entry;
        await chrome.storage.session.set({ [BACKGROUND_CAPTURE_STORAGE_KEY]: entries });
    } catch (_) {}
}

async function forgetBackgroundCaptureEntry(sourceTabId) {
    const key = String(sourceTabId);
    BACKGROUND_CAPTURE_TABS.delete(key);
    try {
        const saved = await chrome.storage.session.get(BACKGROUND_CAPTURE_STORAGE_KEY);
        const entries = saved?.[BACKGROUND_CAPTURE_STORAGE_KEY] || {};
        delete entries[key];
        await chrome.storage.session.set({ [BACKGROUND_CAPTURE_STORAGE_KEY]: entries });
    } catch (_) {}
}

async function closeBackgroundCaptureTab(sourceTabId, captureTabId = 0) {
    const entry = Number.isInteger(sourceTabId) ? await readBackgroundCaptureEntry(sourceTabId) : null;
    const id = Number(captureTabId) || Number(entry?.captureTabId) || 0;
    if (id > 0) {
        try {
            const jobs = await getStoredJobs();
            if (Object.values(jobs || {}).some(job => Number(job?.captureTabId) === id)) return;
        } catch (_) {}
    }
    if (entry && (!captureTabId || Number(entry.captureTabId) === id)) {
        await forgetBackgroundCaptureEntry(sourceTabId);
    }
    if (id > 0 && id !== Number(sourceTabId)) {
        try { await chrome.tabs.remove(id); } catch (_) {}
    }
}

async function releaseBackgroundCaptureForTab(tabId) {
    const sourceEntry = await readBackgroundCaptureEntry(tabId);
    if (sourceEntry) await closeBackgroundCaptureTab(tabId, sourceEntry.captureTabId);
    else {
        try {
            const saved = await chrome.storage.session.get(BACKGROUND_CAPTURE_STORAGE_KEY);
            const entries = saved?.[BACKGROUND_CAPTURE_STORAGE_KEY] || {};
            const owner = Object.entries(entries).find(([, entry]) => Number(entry?.captureTabId) === Number(tabId));
            if (owner) await forgetBackgroundCaptureEntry(Number(owner[0]));
        } catch (_) {}
    }
}

async function waitForBackgroundCaptureTab(tabId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
        let tab;
        try { tab = await chrome.tabs.get(tabId); }
        catch (_) { throw new Error('The background Drive tab closed before it finished loading.'); }
        if (tab.status === 'complete') break;
        await sleep(200);
    }

    while (Date.now() < deadline) {
        const session = await getStoredSession(tabId);
        if (session?.fileId) return session;
        await sleep(250);
    }
    lastError = 'Drive did not finish opening the background video player.';
    throw new Error(lastError);
}

/** Create an inactive Drive tab and start muted playback there for stream capture. */
async function ensureBackgroundCaptureTab(sourceTabId, fileId, requestedCaptureTabId = 0, startPlayback = true) {
    const sourceId = Number(sourceTabId);
    const id = String(fileId || '').trim();
    if (!Number.isInteger(sourceId) || sourceId < 0) throw new Error('Could not identify the tab that started Export.');
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('Could not identify the current Drive video.');

    let entry = await readBackgroundCaptureEntry(sourceId);
    let captureTabId = Number(requestedCaptureTabId) || 0;
    if (!captureTabId && entry?.fileId === id) captureTabId = Number(entry.captureTabId) || 0;

    if (captureTabId) {
        try {
            const tab = await chrome.tabs.get(captureTabId);
            if (!String(tab.url || '').includes(`/file/d/${id}/`)) captureTabId = 0;
        } catch (_) { captureTabId = 0; }
    }

    if (!captureTabId) {
        if (entry?.captureTabId) await closeBackgroundCaptureTab(sourceId, entry.captureTabId);
        let source = null;
        try { source = await chrome.tabs.get(sourceId); } catch (_) {}
        const tab = await chrome.tabs.create({
            url: `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
            active: false,
            ...(Number.isInteger(source?.windowId) ? { windowId: source.windowId } : {})
        });
        captureTabId = tab.id;
        entry = { sourceTabId: sourceId, captureTabId, fileId: id };
        await writeBackgroundCaptureEntry(sourceId, entry);
    }

    const session = await waitForBackgroundCaptureTab(captureTabId);
    if (String(session.fileId || '') !== id) {
        throw new Error('The background Drive tab opened a different video.');
    }
    if (!startPlayback) return captureTabId;

    let lastError = '';
    for (let attempt = 0; attempt < 32; attempt++) {
        const rows = await runQualityDom(captureTabId, 'prepareMutedPlayback');
        const result = rows.find(row => row?.value?.ok)?.value
            || rows.find(row => row?.value?.error)?.value;
        if (result?.ok) {
            await writeBackgroundCaptureEntry(sourceId, { sourceTabId: sourceId, captureTabId, fileId: id });
            return captureTabId;
        }
        lastError = result?.error || lastError;
        if (/blocked muted playback|could not start/i.test(lastError)) break;
        await sleep(350);
    }
    throw new Error(lastError || 'Could not start muted playback in the background Drive tab.');
}

try {
    chrome.tabs.onRemoved.addListener(tabId => { void releaseBackgroundCaptureForTab(tabId); });
} catch (_) {}

/** Open the offscreen document used for chunk download + MP4 remux (MV3 has no DOM in the SW). */
async function ensureVideoOffscreen() {
    const myGen = ++offscreenGeneration;
    const run = offscreenLock.then(async () => {
        if (myGen !== offscreenGeneration) return;

        const url = chrome.runtime.getURL('src/offscreen/video-offscreen.html');
        if (chrome.runtime.getContexts) {
            try {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT'],
                    documentUrls: [url]
                });
                if (contexts.length) return;
            } catch (_) {}
        }

        try {
            await chrome.offscreen.createDocument({
                url: 'src/offscreen/video-offscreen.html',
                reasons: ['BLOBS', 'WORKERS'],
                justification: 'Download and merge Google Drive video/audio streams.'
            });
        } catch (error) {
            const msg = String(error?.message || error || '');
            if (/already exists|single offscreen|only one offscreen/i.test(msg)) return;
            throw error;
        }
    });

    offscreenLock = run.catch(() => {});
    return run;
}

/** Check freshly captured media URLs in the offscreen HTML document before staging a job. */
async function preflightCapturedStreams(streams = []) {
    await ensureVideoOffscreen();
    try {
        let timeout;
        try {
            const result = await Promise.race([
                chrome.runtime.sendMessage({
                    target: 'video-offscreen',
                    type: 'videoStagePreflight',
                    streams
                }),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('Background media URL check timed out.')), 18000);
                })
            ]);
            return result?.success
                ? result
                : { success: false, error: result?.error || 'The captured media URL could not be verified.' };
        } finally {
            clearTimeout(timeout);
        }
    } finally {
        // The offscreen page is also used by active jobs; closeVideoOffscreen
        // checks for queued jobs and pending saves before it closes anything.
        setTimeout(() => { void closeVideoOffscreen(); }, 1200);
    }
}

/** Close offscreen document when no jobs remain. */
async function closeVideoOffscreen() {
    const myGen = offscreenGeneration;
    const run = offscreenLock.then(async () => {
        if (myGen !== offscreenGeneration) return;
        try {
            const jobs = await getStoredJobs();
            if (Object.keys(jobs).length) return;
            // Blob URLs must remain live until Chrome finishes copying the file.
            const pending = (await chrome.storage.local.get('gdrivePendingDiskSaves')).gdrivePendingDiskSaves || {};
            if (Object.keys(pending).length) return;
            await chrome.offscreen.closeDocument();
        } catch (_) {}
    });
    offscreenLock = run.catch(() => {});
    return run;
}

async function createVideoStageJob(sourceTabId, captureTabId, session, mode, payload) {
    const jobId = `gdrive-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await queueJobMutation(jobs => {
        jobs[jobId] = {
            jobId,
            sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
            captureTabId: Number.isInteger(captureTabId) ? captureTabId : null,
            fileId: session?.fileId || '',
            viewerSessionId: session?.viewerSessionId || '',
            filename: payload.filename,
            mode,
            qualityHeight: Number(payload.qualityHeight || 0),
            videoUrl: payload.videoUrl || null,
            audioUrl: payload.audioUrl || null,
            mediaUrl: payload.mediaUrl || null,
            videoBytes: payload.videoBytes || 0,
            audioBytes: payload.audioBytes || 0,
            mediaBytes: payload.mediaBytes || 0,
            mediaMime: payload.mediaMime || 'video/mp4',
            createdAt: Date.now()
        };
    });
    return jobId;
}

async function removeVideoStageJob(jobId) {
    await queueJobMutation(jobs => {
        delete jobs[jobId];
        return true;
    });
}

/** Cancel every job that belongs to a tab (navigation / close / reload). */
async function cancelJobsForTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    let jobs = {};
    try { jobs = await getStoredJobs(); } catch (_) { return; }

    const ids = Object.keys(jobs).filter(id => Number(jobs[id]?.sourceTabId) === Number(tabId));
    for (const jobId of ids) {
        const job = jobs[jobId];
        try {
            if (typeof cancelVideoStage === 'function') {
                await cancelVideoStage(jobId, job, { silent: true });
            } else {
                try { sendOffscreen?.({ type: 'videoStageCancelInternal', jobId }); } catch (_) {}
                await removeVideoStageJob(jobId);
            }
        } catch (_) {}
    }
}

function formatBytes(format) {
    return Number(format?.contentLength) || getStreamBytes(format?.url || '');
}

function stageSizes(selected) {
    if (selected.mode === 'single') {
        return { mediaBytes: formatBytes(selected.media), videoBytes: 0, audioBytes: 0 };
    }
    return {
        mediaBytes: 0,
        videoBytes: formatBytes(selected.video),
        audioBytes: formatBytes(selected.audio)
    };
}

function createStagePayload(selected, filename) {
    const sizes = stageSizes(selected);
    if (selected.mode === 'single') {
        return {
            filename,
            qualityHeight: Number(selected.media.qualityHeight || selected.media.height || 0),
            mediaUrl: cleanURL(selected.media.originalUrl || selected.media.url),
            mediaBytes: sizes.mediaBytes,
            mediaMime: selected.media.mime || 'video/mp4'
        };
    }
    return {
        filename,
        qualityHeight: Number(selected.video.qualityHeight || selected.video.height || 0),
        videoUrl: cleanURL(selected.video.originalUrl || selected.video.url),
        audioUrl: cleanURL(selected.audio.originalUrl || selected.audio.url),
        videoBytes: sizes.videoBytes,
        audioBytes: sizes.audioBytes
    };
}

function validateDownloadContext(session, request) {
    if (request.fileId && session.fileId && String(request.fileId) !== String(session.fileId)) {
        return 'The Drive file changed before download. Please open the quality menu again.';
    }
    if (request.viewerSessionId && session.viewerSessionId && String(request.viewerSessionId) !== String(session.viewerSessionId)) {
        return 'The Drive viewer changed before download. Please open the quality menu again.';
    }
    return '';
}

/** Best available audio for this session (shared track). */
function pickBestAudioFromPools(session, tabId) {
    if (session?.audio) {
        return {
            url: cleanURL(session.audioOriginal || session.audio) || session.audio,
            originalUrl: session.audioOriginal || session.audio,
            contentLength: getStreamBytes(session.audioOriginal || session.audio),
            mime: session.formats?.audio?.[0]?.mime || 'audio/mp4',
            itag: session.formats?.audio?.[0]?.itag || ''
        };
    }

    const pools = [
        ...(Array.isArray(session?.formats?.audio) ? session.formats.audio : []),
        ...(Array.isArray(session?.audioCandidates) ? session.audioCandidates : []),
        ...(tabId != null ? (streamCaptureState(tabId)?.recentStreams || []).filter(isAudioStream) : [])
    ].filter(item => item?.url);

    const globalAudio = typeof getGlobalLastAudio === 'function' ? getGlobalLastAudio() : null;
    if (globalAudio?.url) pools.push(globalAudio);

    const best = dedupeAudioFormats(pools).sort((a, b) =>
        (Number(b.contentLength || 0) - Number(a.contentLength || 0)) ||
        (Number(b.capturedAt || 0) - Number(a.capturedAt || 0))
    )[0] || null;

    if (best?.url) return best;

    const urlOnly = getBestAudioURL(session);
    if (!urlOnly) return null;
    return {
        url: cleanURL(urlOnly),
        originalUrl: urlOnly,
        contentLength: getStreamBytes(urlOnly)
    };
}

/** Resolve video (or progressive) stream from session pools matching the request. */
function pickVideoFromPools(session, request, tabId) {
    const formats = session?.formats || { video: [], audio: [], progressive: [] };
    const find = (list, id) => Array.isArray(list) ? list.find(item => item?.id === id && item?.url && (!wantHeight || matchesQualityStream(item, wantHeight))) : null;
    const wantHeight = Number(request?.qualityHeight || 0);

    const selectedProgressive = find(formats.progressive, request.progressiveFormatId)
        || (wantHeight ? (formats.progressive || []).find(item => matchesQualityStream(item, wantHeight)) : null);
    if (selectedProgressive) return { mode: 'single', media: selectedProgressive };

    let video = wantHeight
        ? (formats.video || []).find(item => matchesQualityStream(item, wantHeight))
        : null;
    if (!video) video = find(formats.video, request.videoFormatId);
    if (!wantHeight && !video && formats.video?.length) {
        video = formats.video.find(item => item?.url) || formats.video[0];
    }

    if (!video?.url) {
        const candidates = [
            ...(Array.isArray(session?.videoCandidates) ? session.videoCandidates : []),
            ...(tabId != null
                ? (streamCaptureState(tabId)?.recentStreams || []).filter(s => s?.url && !isAudioStream(s))
                : [])
        ];
        if (wantHeight) {
            video = candidates.find(item => matchesQualityStream(item, wantHeight));
        }
        if (!wantHeight && !video?.url) video = candidates.find(item => item?.url) || null;
    }

    if (!wantHeight && !video?.url && session?.video) {
        video = {
            url: session.video,
            originalUrl: session.videoOriginal || session.video,
            height: wantHeight || 0,
            qualityHeight: wantHeight || 0
        };
    }

    if (!video?.url) return null;
    if (isMuxedStream(video)) return { mode: 'single', media: { ...video, progressive: true } };
    return { mode: 'adaptive', video };
}

/**
 * Build { mode, video, audio } or { mode: 'single', media } from session + request.
 * Prefer explicit URLs from the quality picker when present.
 */
function selectFormats(session, request, tabId = null) {
    const picked = pickVideoFromPools(session, request, tabId);
    if (!picked) return null;

    if (picked.mode === 'single') return picked;

    const audio = pickBestAudioFromPools(session, tabId);
    if (!audio?.url) return { ...picked, audio: null, missingAudio: true };
    return { ...picked, audio };
}

/**
 * Start download of the already-selected quality.
 *
 * Flow:
 * 1. Validate session matches request
 * 2. Resolve video + audio (or progressive) URLs
 * 3. Create job, open offscreen, notify UI
 * 4. Offscreen downloads 4 MiB ranges, remuxes, triggers browser download
 */
async function startVideoDownload(tabId, request = {}) {
    const captureTabId = await ensureBackgroundCaptureTab(
        tabId, request.fileId, request.captureTabId, !Number(request.captureTabId)
    );
    const session = await getStoredSession(captureTabId);
    if (!session) return { success: false, error: 'No active Drive video session was found.' };

    const contextError = validateDownloadContext(session, {
        ...request,
        viewerSessionId: session.viewerSessionId || ''
    });
    if (contextError) return { success: false, error: contextError };

    // Prefer URLs supplied by the quality picker; fall back to session pools.
    let selected = null;
    if (request.videoUrl) {
        const parsedVideo = parseStreamCandidate(request.videoUrl);
        if (request.qualityHeight && parsedVideo?.height && Math.abs(Number(request.qualityHeight) - parsedVideo.height) > 8) {
            return { success: false, error: 'The captured stream does not match the selected resolution. Choose the quality again.' };
        }
        if (isAudioStream(parsedVideo)) return { success: false, error: 'An audio-only URL cannot be used for the selected video.' };
        const video = {
            ...parsedVideo,
            url: cleanURL(request.videoUrl) || request.videoUrl,
            originalUrl: request.videoUrl,
            height: Number(request.qualityHeight || 0),
            qualityHeight: Number(request.qualityHeight || 0),
            probeQuality: request.qualityLabel || ''
        };

        if (isMuxedStream(video)) {
            selected = { mode: 'single', media: { ...video, progressive: true } };
        } else if (request.audioUrl) {
            selected = {
                mode: 'adaptive',
                video,
                audio: {
                    url: cleanURL(request.audioUrl) || request.audioUrl,
                    originalUrl: request.audioUrl,
                    mime: 'audio/mp4'
                }
            };
        } else {
            const audio = pickBestAudioFromPools(session, captureTabId);
            if (audio?.url) {
                selected = {
                    mode: 'adaptive',
                    video,
                    audio: {
                        url: cleanURL(audio.originalUrl || audio.url) || audio.url,
                        originalUrl: audio.originalUrl || audio.url,
                        contentLength: Number(audio.contentLength) || 0,
                        mime: audio.mime || 'audio/mp4',
                        itag: audio.itag || ''
                    }
                };
            } else {
                selected = { mode: 'adaptive', video, audio: null, missingAudio: true };
            }
        }
    }

    if (!selected) selected = selectFormats(session, request, captureTabId);

    if (!selected) {
        return {
            success: false,
            error: 'No usable video stream was found in the background player. Try Export again.'
        };
    }
    if (selected.missingAudio || (selected.mode === 'adaptive' && !selected.audio?.url)) {
        return {
            success: false,
            error: 'The background player did not provide an audio track. Try Export again.'
        };
    }

    const finalFilename = sanitizeVideoFilename(request.filename || session.filename || 'gdrive-video');
    const stagePayload = createStagePayload(selected, finalFilename);
    const sizes = stageSizes(selected);

    let jobId = '';
    try {
        jobId = await createVideoStageJob(
            tabId,
            captureTabId,
            session,
            selected.mode === 'single' ? 'single' : 'adaptive',
            stagePayload
        );

        await ensureVideoOffscreen();
        await sendTab(tabId, { type: 'videoStagePreload', jobId, ...sizes });
        await sendTab(tabId, { type: 'videoStageStarted', jobId, ...sizes });
        // The picker activates this job only after the overlay is ready.
        // Starting here could let a fast download finish before the caller
        // associates its job ID, leaving the next attempt stuck on Processing.
        return { success: true, jobId, ...sizes };
    } catch (error) {
        if (jobId) await removeVideoStageJob(jobId);
        return { success: false, error: error?.message || String(error) };
    }
}

// Coalesce simultaneous audio/video failures into one player recapture.
const sourceRefreshes = new Map();
function refreshVideoStageStreams({ request }) {
    const jobId = String(request.jobId || '');
    if (sourceRefreshes.has(jobId)) return sourceRefreshes.get(jobId);
    const work = (async () => {
        const job = (await getStoredJobs())[jobId];
        if (!job || !['single', 'adaptive'].includes(job.mode)) return { success: false, error: 'No active video download.' };
        const captureTabId = Number(job.captureTabId) || Number(job.sourceTabId);
        const session = await getStoredSession(captureTabId);
        if (!session || validateDownloadContext(session, { fileId: job.fileId, viewerSessionId: session.viewerSessionId })) return { success: false, error: 'The Drive viewer changed.' };
        const height = Number(job.qualityHeight || parseStreamCandidate(job.videoUrl || job.mediaUrl)?.height || 0);
        if (!height) return { success: false, error: 'Could not identify the selected quality.' };
        const capture = await handleCaptureQualityForDownload({
            tabId: job.sourceTabId,
            request: {
                fileId: job.fileId,
                captureTabId,
                qualityHeight: height,
                qualityLabel: height + 'p',
                forceFresh: true
            }
        });
        if (!capture?.success || !capture.video?.url || (job.mode === 'adaptive' && !capture.audio?.url)) {
            return { success: false, error: 'Fresh video and audio streams were not captured in the background player. Try Export again.' };
        }
        const current = await getStoredSession(captureTabId);
        if (!current || validateDownloadContext(current, { fileId: job.fileId, viewerSessionId: current.viewerSessionId })) return { success: false, error: 'The Drive viewer changed.' };
        const capturedVideo = { ...parseStreamCandidate(capture.video.originalUrl || capture.video.url), ...capture.video };
        if ((job.mode === 'single') !== isMuxedStream(capturedVideo)) {
            return { success: false, error: 'The stream format changed. Choose the quality again.' };
        }
        const selected = job.mode === 'single'
            ? { mode: 'single', media: capturedVideo }
            : { mode: 'adaptive', video: capturedVideo, audio: capture.audio };
        const payload = createStagePayload(selected, job.filename);
        let updated = false;
        await queueJobMutation(jobs => {
            if (!jobs[jobId]) return false;
            Object.assign(jobs[jobId], payload);
            updated = true;
        });
        return updated ? { success: true, ...payload } : { success: false, error: 'The download was cancelled.' };
    })();
    sourceRefreshes.set(jobId, work);
    void work.finally(() => { if (sourceRefreshes.get(jobId) === work) sourceRefreshes.delete(jobId); }).catch(() => {});
    return work;
}
