/* Inspect disk-backed MP4 boxes without allocating the media payload in memory. */
(() => {
    function invalid(label, detail) {
        return Object.assign(new Error(`${label} is not a complete MP4 track (${detail}). Play the video and try Download again.`), { name: 'MediaValidationError' });
    }

    async function inspect(file, label, check = () => {}) {
        const tracks = [];
        let mediaBytes = 0;
        let hasType = false;
        let hasMovie = false;
        let count = 0;
        async function header(offset, limit) {
            check();
            if (++count > 100000 || limit - offset < 8) throw invalid(label, 'invalid box header');
            const data = new DataView(await file.slice(offset, Math.min(offset + 16, limit)).arrayBuffer());
            let size = data.getUint32(0);
            let bytes = 8;
            if (size === 1) {
                if (data.byteLength < 16) throw invalid(label, 'truncated large box');
                size = Number(data.getBigUint64(8));
                bytes = 16;
            }
            if (!size) size = limit - offset;
            if (!Number.isSafeInteger(size) || size < bytes || offset + size > limit) {
                throw invalid(label, 'truncated media data');
            }
            const type = String.fromCharCode(...new Uint8Array(data.buffer, 4, 4));
            return { type, start: offset + bytes, end: offset + size };
        }
        async function scan(start, end, level = '') {
            let handler = '';
            let duration = 0;
            for (let offset = start; offset < end;) {
                const box = await header(offset, end);
                if (!level) {
                    if (offset === 0 && box.type !== 'ftyp' && box.type !== 'styp') throw invalid(label, 'missing MP4 header');
                    if (box.type === 'ftyp' || box.type === 'styp') hasType = true;
                    if (box.type === 'mdat') mediaBytes += box.end - box.start;
                    if (box.type === 'moov') { hasMovie = true; await scan(box.start, box.end, 'moov'); }
                } else if (box.type === 'trak' || box.type === 'mdia') {
                    await scan(box.start, box.end, box.type);
                } else if (level === 'mdia' && box.type === 'hdlr' && box.end - box.start >= 12) {
                    const data = new Uint8Array(await file.slice(box.start + 8, box.start + 12).arrayBuffer());
                    handler = String.fromCharCode(...data);
                } else if (level === 'mdia' && box.type === 'mdhd') {
                    const data = new DataView(await file.slice(box.start, Math.min(box.start + 32, box.end)).arrayBuffer());
                    const version = data.getUint8(0);
                    const needed = version === 1 ? 32 : 20;
                    if (data.byteLength < needed) throw invalid(label, 'truncated track metadata');
                    const scale = data.getUint32(version === 1 ? 20 : 12);
                    const ticks = version === 1 ? Number(data.getBigUint64(24)) : data.getUint32(16);
                    if (scale && ticks && ticks !== 0xffffffff) duration = ticks / scale;
                }
                offset = box.end;
            }
            if (level === 'mdia' && handler) tracks.push({ handler, duration });
        }
        await scan(0, file.size);
        if (!hasType || !hasMovie || !mediaBytes) throw invalid(label, 'no media samples');
        const kind = label === 'audio' ? 'soun' : 'vide';
        if (!tracks.some(track => track.handler === kind)) throw invalid(label, `missing ${label} track`);
        return { tracks, mediaBytes };
    }

    function validatePair(video, audio) {
        const videoDuration = video.tracks.find(track => track.handler === 'vide')?.duration || 0;
        const audioDuration = audio.tracks.find(track => track.handler === 'soun')?.duration || 0;
        if (videoDuration && audioDuration && Math.abs(videoDuration - audioDuration) > Math.max(2, videoDuration * 0.01)) {
            throw new Error('Video and audio durations do not match. Refresh Drive to capture fresh tracks and retry.');
        }
    }
    window.GDriveVideoMedia = { inspect, validatePair };
})();
