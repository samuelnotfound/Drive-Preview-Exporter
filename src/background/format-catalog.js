// ============================================================================
// FILE: src/background/format-catalog.js
// PURPOSE: Core format cataloging, metadata extraction, itag classification,
//          deduplication, hashing, and sorting logic for audio/video media streams.
// ============================================================================

/** Remove byte ranges without changing signed query parameters or their encoding. */
function cleanURL(url) {
    return url ? GDriveStreamURL.withoutRange(url) : null;
}

/**
 * Regular expression matching adaptive audio-only itags (Google/YouTube formats).
 *
 * ITAG DEFINITIONS:
 * - 139: AAC Audio ~48 kbps
 * - 140: AAC Audio ~128 kbps (most common in Drive)
 * - 141: AAC Audio ~256 kbps
 * - 249: Opus Audio ~50 kbps
 * - 250: Opus Audio ~70 kbps
 * - 251: Opus Audio ~160 kbps
 * - 256, 258: AAC multichannel / high bitrate
 * - 327, 328: High quality audio tracks
 * - 599, 600: Ultra low-bitrate audio
 */
const AUDIO_ITAG_PATTERN = /^(139|140|141|249|250|251|256|258|327|328|599|600)$/;

/**
 * Regular expression matching muxed (progressive) itags.
 *
 * PURPOSE:
 * Progressive formats contain both video and audio multiplexed together in a single stream.
 * They do not require a separate audio track or MP4 remuxing.
 * - 18: 360p MP4 (H.264 + AAC)
 * - 22: 720p MP4 (H.264 + AAC)
 * - 37: 1080p MP4 (H.264 + AAC)
 * - 43, 44, 45, 46: WebM / VP8 progressive streams
 */
const MUXED_ITAG_PATTERN = /^(18|22|34|35|37|38|43|44|45|46|59|78|82|83|84|85)$/;

/**
 * Classifies whether a captured stream descriptor represents an audio track.
 *
 * HEURISTICS:
 * 1. Checks `mime` property for "audio" (e.g. "audio/mp4", "audio/webm").
 * 2. Checks raw or original URL query string for `mime=audio`.
 * 3. Checks if `itag` matches known audio itags in `AUDIO_ITAG_PATTERN`.
 *
 * @param {Object} stream - Stream descriptor object
 * @returns {boolean} True if classified as audio
 */
function isAudioStream(stream) {
    // 1. Prefer explicit mime property
    if (/audio/i.test(String(stream?.mime || ''))) return true;
    // 2. Check query string in raw URL where mime parameter may reside
    if (/[?&]mime=audio/i.test(String(stream?.originalUrl || stream?.url || ''))) return true;
    // 3. Fallback to itag regex lookup
    if (AUDIO_ITAG_PATTERN.test(String(stream?.itag || ''))) return true;
    return false;
}

/**
 * Checks whether a stream is progressive (contains both audio and video multiplexed).
 *
 * @param {Object} stream - Stream descriptor object
 * @returns {boolean} True if muxed progressive
 */
function isMuxedStream(stream) {
    if (!stream?.url) return false;
    // Audio-only streams can never be muxed progressive videos
    if (isAudioStream(stream)) return false;
    // Match against known progressive itags
    if (MUXED_ITAG_PATTERN.test(String(stream?.itag || ''))) return true;
    // Accept explicit progressive boolean flag if set by parser
    return !!stream.progressive;
}

/** Comparator: sorts objects by contentLength in descending order (largest first) */
const bySizeDesc = (a, b) => Number(b.contentLength || 0) - Number(a.contentLength || 0);

/** Comparator: sorts objects by vertical resolution (height) descending, then size descending */
const byHeightThenSize = (a, b) => (Number(b.height || 0) - Number(a.height || 0)) || bySizeDesc(a, b);

/** Comparator: sorts by height descending, then width descending, then size descending */
const byHeightWidthThenSize = (a, b) =>
    (Number(b.height || 0) - Number(a.height || 0)) || (Number(b.width || 0) - Number(a.width || 0)) || bySizeDesc(a, b);

/**
 * Sanitizes a filename for local disk saving.
 *
 * @param {string} name - Raw file name from Google Drive page/tab title
 * @returns {string} Safe, sanitized filename with video extension
 */
function sanitizeVideoFilename(name) {
    let value = String(name || '').trim()
        .replace(/[\\/:*?"<>|]+/g, '_')   // Replace Windows/POSIX reserved characters
        .replace(/[\x00-\x1F]/g, '')      // Remove ASCII control characters
        .trim();
    if (!value) value = 'gdrive-video';
    // Append .mp4 if no valid video extension is present
    return /\.(mp4|m4v|webm|mov|avi|mkv|flv|3gp)$/i.test(value) ? value : `${value}.mp4`;
}

/**
 * Factory creating a fresh blank tab video session state object.
 *
 * PURPOSE:
 * Holds the in-flight state of a Drive tab: file identifiers, active stream URLs,
 * lists of discovered audio/video formats, probe status, and bridge tokens.
 *
 * @param {string} [fileId=''] - Google Drive file ID
 * @param {string} [filename=''] - Display filename
 * @param {string} [viewerSessionId=''] - Drive viewer session token
 * @returns {Object} Fresh session schema
 */
function emptySession(fileId = '', filename = '', viewerSessionId = '') {
    return {
        fileId: String(fileId || ''),
        filename: String(filename || 'gdrive-video'),
        viewerSessionId: String(viewerSessionId || ''),
        pageBridgeId: '',
        playbackStarted: false,
        streamCaptureEnabled: false,
        video: null,
        audio: null,
        videoOriginal: null,
        audioOriginal: null,
        audioCandidates: [],
        videoCandidates: [],
        formats: {
            video: [],
            audio: [],
            progressive: []
        },
        formatsFetchedAt: 0,
        activeQualityProbe: null,
        probeCandidates: []
    };
}

/**
 * Extracts total stream size in bytes from the 'clen' query parameter in a video URL.
 *
 * @param {string} url - Stream URL
 * @returns {number} Total bytes or 0 if absent/invalid
 */
function getStreamBytes(url) {
    if (!url) return 0;
    try {
        const bytes = Number(new URL(url).searchParams.get('clen'));
        return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * 32-bit FNV-1a (Fowler-Noll-Vo) non-cryptographic hash function.
 *
 * @param {string} value - String to hash
 * @returns {string} Compact base-36 hash string
 */
function formatHash(value) {
    let hash = 2166136261;
    const str = String(value || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * Parses a captured network request URL into a structured format candidate descriptor.
 *
 * @param {string} url - Cleaned or raw stream URL
 * @param {string} [originalUrl=url] - Original URL before range stripping
 * @returns {Object} Structured format candidate descriptor
 */
function parseStreamCandidate(url, originalUrl = url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const p = parsed.searchParams;
        const mime = p.get('mime') || '';
        const clen = getStreamBytes(url);
        const itag = p.get('itag') || '';

        // Standard itag to resolution [width, height] lookup table
        const ITAG_DIMS = {
            '160':[256,144], '133':[426,240], '134':[640,360], '135':[854,480],
            '136':[1280,720], '137':[1920,1080], '264':[2560,1440], '266':[3840,2160],
            '242':[426,240], '243':[640,360], '244':[854,480], '247':[1280,720], '248':[1920,1080],
            '298':[1280,720], '299':[1920,1080], '18':[640,360], '22':[1280,720],
            // Drive's muxed/legacy itags: 37 (1080p), 59 (480p), 43-46 (WebM)
            '34':[640,360], '35':[854,480], '37':[1920,1080], '43':[640,360],
            '44':[854,480], '45':[1280,720], '46':[1920,1080], '59':[854,480]
        };

        const dims = ITAG_DIMS[itag] || [0, 0];
        const urlWidth = Number(p.get('width')) || 0;
        const urlHeight = Number(p.get('height')) || 0;

        // Prefer explicit width/height parameters in URL query over static itag table
        const fromUrl = urlWidth > 0 || urlHeight > 0;
        const width = urlWidth || Number(dims[0]) || 0;
        const height = urlHeight || Number(dims[1]) || 0;

        // Extract Google Drive file/doc ID if passed in stream query
        const streamFileId = p.get('driveid') || p.get('driveId') || p.get('fileid') || p.get('fileId') || p.get('docid') || '';

        return {
            id: `captured:${p.get('itag') || ''}:${formatHash(cleanURL(url))}`,
            url: cleanURL(url),
            originalUrl,
            fileId: streamFileId,
            mime,
            itag,
            width,
            height,
            heightSource: height ? (fromUrl ? 'url' : (itag && dims[1] ? 'itag' : '')) : '',
            contentLength: clen,
            codecs: p.get('codecs') || '',
            capturedAt: Date.now()
        };
    } catch (_) {
        // Fallback for malformed URLs
        return {
            id: `captured:${formatHash(cleanURL(url))}`,
            url: cleanURL(url),
            originalUrl,
            fileId: '',
            mime: '',
            itag: '',
            width: 0,
            height: 0,
            contentLength: getStreamBytes(url),
            codecs: '',
            capturedAt: Date.now()
        };
    }
}

/**
 * Prepends a new candidate to a format list while enforcing deduplication and max length.
 *
 * @param {Array<Object>} list - Existing list of candidates
 * @param {Object} candidate - New candidate format descriptor
 * @param {number} [max=12] - Max items to retain
 * @returns {Array<Object>} Updated deduplicated list
 */
function addUniqueCandidate(list, candidate, max = 12) {
    if (!candidate?.url) return Array.isArray(list) ? list.slice(0, max) : [];
    const existing = Array.isArray(list) ? list : [];

    // Generates a distinct identity key for deduplication
    const identity = item => {
        const itag = String(item?.itag || '').trim();
        const isAudio = isAudioStream(item);
        if (itag) {
            const quality = Number(item?.height || 0);
            const width = Number(item?.width || 0);
            const probeQuality = String(item?.probeQuality || '').trim().toLowerCase();
            return `${isAudio ? 'audio' : 'video'}|itag:${itag}|q:${quality || 0}|w:${width}|probe:${probeQuality}`;
        }
        return `url:${cleanURL(item?.url || '')}`;
    };

    const key = identity(candidate);
    return [candidate, ...existing.filter(item => identity(item) !== key)].slice(0, max);
}

/**
 * Deduplicates audio formats across multiple probe cycles and page reloads.
 *
 * PURPOSE & COMPLICATION:
 * When testing different video qualities, Google Drive re-requests audio segments.
 * Each request carries a fresh URL signature and timestamp, but represents the same
 * physical audio track (same itag and byte length).
 * This function groups tracks by itag/codecs, keeps the newest signed URL (since Google's
 * signed URLs expire after hours), and pairs streams with unknown contentLength to known ones.
 *
 * @param {Array<Object>} list - Raw audio candidates
 * @returns {Array<Object>} One entry per distinct audio track
 */
function dedupeAudioFormats(list) {
    const items = (Array.isArray(list) ? list : []).filter(x => x?.url);
    // Key by itag, or fallback to mime + audio codec
    const idOf = x => String(x.itag || '').trim() || `${String(x.mime || '').toLowerCase()}|${String(x.acodec || x.codecs || '').toLowerCase()}`;

    // Group candidates by format identifier
    const groups = new Map();
    for (const x of items) {
        const k = idOf(x);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
    }

    const newer = (a, b) => Number(a?.capturedAt || 0) >= Number(b?.capturedAt || 0);
    const out = [];

    // Process each audio group
    for (const arr of groups.values()) {
        const byLen = new Map();
        for (const x of arr) {
            const len = Number(x.contentLength || 0);
            const prev = byLen.get(len);
            // Always prefer the newest capture of the same size (freshest signature)
            if (!prev || newer(x, prev)) byLen.set(len, x);
        }

        const known = [...byLen.keys()].filter(l => l > 0);
        const unknown = byLen.get(0);
        byLen.delete(0);

        if (known.length) {
            // If we have an unknown size stream and a single known size stream, merge them
            if (unknown && known.length === 1) {
                const sized = byLen.get(known[0]);
                if (!newer(sized, unknown)) byLen.set(known[0], { ...unknown, contentLength: known[0] });
            }
        } else if (unknown) {
            byLen.set(0, unknown);
        }
        out.push(...byLen.values());
    }
    return out;
}

/**
 * Generates a stable format key for deduplicating video and audio items.
 *
 * @param {Object} format - Media format descriptor
 * @returns {string} Composite string key
 */
function stableFormatKey(format) {
    if (!format) return '';
    // Classify kind: audio, video, or format
    const kind = (format.acodec && !format.height && !format.width) ? 'audio' : (Number(format.height || 0) > 0 || /video/i.test(String(format.mime || '')) ? 'video' : String(format.kind || 'format'));
    const itag = String(format.itag || '').trim();
    const width = Number(format.width) || 0;
    const height = Number(format.height) || 0;
    const probeQuality = String(format.probeQuality || '').trim().toLowerCase();

    // If itag exists, combine kind, itag, dimensions, and probe label
    if (itag) return `${kind}|itag:${itag}|${width}x${height}|probe:${probeQuality}`;

    // Fallback key using codecs and content length
    const mime = String(format.mime || '').toLowerCase();
    const vcodec = String(format.vcodec || format.videoCodecString || '').toLowerCase();
    const acodec = String(format.acodec || format.audioCodecString || '').toLowerCase();
    const bytes = Number(format.contentLength) || 0;
    return `${kind}|${width}x${height}|${mime}|${vcodec}|${acodec}|${bytes}`;
}

/**
 * Merges two format lists, deduplicating on stableFormatKey, preferring newer captures,
 * sorting by comparator function, and limiting results.
 *
 * @param {Array<Object>} first - First list of formats
 * @param {Array<Object>} second - Second list of formats
 * @param {Function} sortFn - Sort comparator (e.g. byHeightThenSize)
 * @param {number} [max=24] - Max entries to return
 * @returns {Array<Object>} Merged, deduplicated, sorted array
 */
function mergeFormatLists(first, second, sortFn, max = 24) {
    const map = new Map();
    // Iterate over combined arrays
    for (const item of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
        if (!item?.url) continue;
        const key = stableFormatKey(item) || item.url;
        const existing = map.get(key);
        // Replace existing entry if new item is fresher
        if (!existing || Number(item.capturedAt || 0) >= Number(existing.capturedAt || 0)) {
            map.set(key, item);
        }
    }
    // Sort and truncate
    return [...map.values()].sort(sortFn).slice(0, max);
}
