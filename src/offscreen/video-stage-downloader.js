
(() => {
    const NS = 'GDriveVideoStreamDownloader';
    const jobControllers = new Map();
    const cancelledJobs = new Set();
    const activeRuns = new Map();
    /** Per-job download-phase state: live attempts + streams waiting for a manual restart. */
    const jobRuntime = new Map();

    const CHUNK_SIZE = 4 * 1024 * 1024;
    /** Limit simultaneous requests per stream to avoid overloading Drive. */
    const STREAM_WORKERS = { video: 4, audio: 4 };
    /** No bytes received for this long → treat the stream as stuck and resume it. */
    const STUCK_MS = 20000;
    /** Automatic resumes per stream before we stop and wait for the user's Restart click. */
    const MAX_STUCK_RESTARTS = 2;
    /** Retries for one failed range request (each retry tries Range header, then ?range=). */
    const CHUNK_RETRIES = 3;
    const RETRY_BASE_MS = 300;

    function postStageMessage(type, payload = {}) {
        try {
            return chrome.runtime.sendMessage({ type, ...payload }).catch?.(() => {});
        } catch (_) {
            return Promise.resolve();
        }
    }

    function abortError(message = 'Download cancelled.') {
        return Object.assign(new Error(message), { name: 'AbortError' });
    }

    function isAbortError(error, jobId = '') {
        return cancelledJobs.has(jobId)
            || error?.name === 'AbortError'
            || /aborted|abort/i.test(String(error?.message || error || ''));
    }

    function throwIfCancelled(jobId) {
        if (cancelledJobs.has(jobId)) throw abortError();
    }

    function sleepAbortable(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            const onAbort = () => { clearTimeout(timer); reject(abortError()); };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function getJob(jobId) {
        return await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'getVideoStageJob', jobId }, response => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (!response?.job) reject(new Error(response?.error || 'Staging job was not found.'));
                else resolve(response.job);
            });
        });
    }

    /** Remove existing range param so we control ranges ourselves. */
    function cleanStageURL(url) {
        if (!url) return url;
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('range');
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }

    function makeRangeQueryURL(url, start, end) {
        try {
            const parsed = new URL(url);
            parsed.searchParams.delete('range');
            parsed.searchParams.set('range', `${start}-${end}`);
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }

    /** "bytes 0-4194303/24589214" → { start, end, total } (total 0 when "*"). */
    function parseContentRange(value) {
        const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(value || ''));
        if (!m) return null;
        return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? 0 : Number(m[3]) };
    }

    function rangeUnsupported(message) {
        return Object.assign(new Error(message), { name: 'RangeUnsupportedError' });
    }

    /**
     * Some Drive audio responses omit Content-Length even for ?range=0-0.
     * Check at most two response bytes before trusting a headerless probe.
     * Never buffer a full stream just to decide whether it supports ranges.
     */
    async function isSingleByteResponse(response) {
        const reader = response.body?.getReader?.();
        if (!reader) return false;
        let received = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return received === 1;
                received += value?.byteLength || 0;
                if (received > 1) return false;
            }
        } finally {
            try { await reader.cancel(); } catch (_) {}
            try { reader.releaseLock(); } catch (_) {}
        }
    }

    /**
     * Read a response body while reporting every network read, so progress
     * (and stuck detection) is byte-accurate instead of per-4-MiB-chunk.
     */
    async function readBody(response, onBytes, maxBytes = Infinity) {
        if (!response.body?.getReader) {
            const whole = new Uint8Array(await response.arrayBuffer());
            if (whole.byteLength > maxBytes) {
                throw new Error('The server sent more bytes than requested.');
            }
            onBytes(whole.byteLength);
            return whole;
        }
        const reader = response.body.getReader();
        const parts = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value?.byteLength) {
                    if (size + value.byteLength > maxBytes) {
                        try { await reader.cancel(); } catch (_) {}
                        throw new Error('The server sent more bytes than requested.');
                    }
                    parts.push(value);
                    size += value.byteLength;
                    onBytes(value.byteLength);
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (_) {}
        }
        if (parts.length === 1) return parts[0];
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
        return out;
    }

    /**
     * Confirm byte-range support before opening multiple connections. A 200
     * response to a Range header is not proof that parallel chunks are safe.
     * Google's ?range= form is also supported when it returns an exact slice.
     * Prefer headers. For headerless ?range probes, read at most two bytes
     * before cancelling, so we never buffer a full file during discovery.
     */
    async function probeStream(baseUrl, totalHint, ctx) {
        let total = Math.max(0, Number(totalHint) || 0);
        const probes = [
            { mode: 'header', url: baseUrl, headers: { Range: 'bytes=0-0' } },
            { mode: 'query', url: makeRangeQueryURL(baseUrl, 0, 0), headers: {} }
        ];

        for (const probe of probes) {
            try {
                const response = await fetch(probe.url, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: ctx.signal,
                    headers: probe.headers
                });
                ctx.markProgress();
                const range = parseContentRange(response.headers.get('content-range'));
                const length = Number(response.headers.get('content-length')) || 0;
                if (response.status === 206 && range?.start === 0 && range.end === 0) {
                    if (range.total > 0) total = range.total;
                    if (total > 0) {
                        try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
                        return { total, mode: probe.mode };
                    }
                }
                // Some Drive URLs respond 200 to ?range=0-0 but return one byte.
                if (probe.mode === 'query' && response.status === 200 && total > 1) {
                    if (length === 1) {
                        try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
                        return { total, mode: 'query' };
                    }
                    if (!length && await isSingleByteResponse(response)) {
                        return { total, mode: 'query' };
                    }
                }
                // Do not replace a valid clen hint with a one-byte 200 probe.
                // Some servers reply to Range: bytes=0-0 with status 200 and
                // Content-Length: 1. That must not turn a large audio stream
                // into a "1 byte file" before we try Google's ?range= form.
                if (probe.mode === 'header' && response.status === 200 && !total && length > 1) {
                    total = length;
                }
                try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
            } catch (err) {
                if (ctx.signal.aborted || err?.name === 'AbortError') throw err;
            }
        }
        return { total, mode: null };
    }

    /**
     * Fetch one inclusive range. Tries the HTTP Range header first, then
     * ?range=start-end. Returns { data, total, whole } where `total` is the
     * server-confirmed stream size (0 if unknown). Never returns an empty body.
     */
    async function fetchRange(baseUrl, start, end, ctx, label) {
        const attempts = [
            { mode: 'header', url: baseUrl, headers: { Range: `bytes=${start}-${end}` } },
            { mode: 'query', url: makeRangeQueryURL(baseUrl, start, end), headers: {} }
        ].filter(attempt => !ctx.rangeMode || attempt.mode === ctx.rangeMode);

        let lastError = null;
        for (const attempt of attempts) {
            try {
                throwIfCancelled(ctx.jobId);
                let inflight = 0;
                const onBytes = n => { inflight += n; ctx.markProgress(); ctx.report(inflight); };

                const response = await fetch(attempt.url, {
                    credentials: 'include',
                    cache: 'no-store',
                    signal: ctx.signal,
                    headers: attempt.headers
                });
                ctx.markProgress();

                if (!response.ok && response.status !== 206) {
                    lastError = new Error(`${label} download failed (${response.status})`);
                    try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
                    continue;
                }

                const range = parseContentRange(response.headers.get('content-range'));
                const expected = end - start + 1;
                const declared = Number(response.headers.get('content-length')) || 0;
                if (ctx.strictRange && (
                    (attempt.mode === 'header' && response.status !== 206)
                    || (response.status === 206 && !range)
                    || (response.status === 200 && declared > expected)
                )) {
                    try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
                    throw rangeUnsupported(`${label} server stopped supporting byte ranges`);
                }

                if (range && (
                    range.start !== start || range.end > end || range.end < range.start
                    || (range.total > 0 && range.total <= range.end)
                )) {
                    try { response.body?.cancel()?.catch?.(() => {}); } catch (_) {}
                    lastError = new Error(`${label} server returned the wrong byte range`);
                    continue;
                }
                const body = await readBody(response, onBytes, ctx.strictRange ? expected : Infinity);
                if (!body.byteLength) {
                    lastError = new Error(`${label} download returned no data`);
                    continue;
                }

                if (ctx.strictRange && (body.byteLength > expected
                    || (range && body.byteLength !== range.end - range.start + 1))) {
                    lastError = new Error(`${label} received an invalid chunk length`);
                    continue;
                }

                // Server ignored the Range header and sent the whole file.
                if (attempt.mode === 'header' && response.status === 200) {
                    if (start === 0) return { data: body, total: body.byteLength, whole: true };
                    if (body.byteLength > end) {
                        return { data: body.subarray(start, end + 1), total: body.byteLength, whole: false };
                    }
                    lastError = new Error(`${label} server ignored the range request`);
                    continue;
                }

                return { data: body, total: range?.total || 0, whole: false };
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                if (err?.name === 'RangeUnsupportedError') throw err;
                lastError = err;
            } finally {
                // Clear the current attempt's in-flight bytes on failure or
                // completion so retries and other workers cannot double-count.
                ctx.report(0);
            }
        }
        throw lastError || new Error(`${label} download failed`);
    }

    async function fetchRangeWithRetry(baseUrl, start, end, ctx, label) {
        let lastError = null;
        for (let i = 0; i < CHUNK_RETRIES; i++) {
            try {
                return await fetchRange(baseUrl, start, end, ctx, label);
            } catch (err) {
                if (err?.name === 'AbortError' || err?.name === 'RangeUnsupportedError'
                    || cancelledJobs.has(ctx.jobId)) throw err;
                lastError = err;
                if (i + 1 < CHUNK_RETRIES) {
                    await sleepAbortable(RETRY_BASE_MS * (i + 1), ctx.signal);
                }
            }
        }
        throw lastError || new Error(`${label} download failed`);
    }

    /** Stream a non-ranged response directly to disk, regardless of file size. */
    async function pullWhole(st, baseUrl, label, ctx) {
        // Without ranges an interrupted transfer must start at byte zero.
        await st.disk.reset();
        st.bytes = 0;
        const response = await fetch(baseUrl, {
            credentials: 'include', cache: 'no-store', signal: ctx.signal
        });
        if (!response.ok) throw new Error(`${label} download failed (${response.status})`);
        const declared = Number(response.headers.get('content-length')) || 0;
        const reader = response.body?.getReader?.();
        if (!reader) throw new Error('This browser cannot stream the response to disk.');
        try {
            for (;;) {
                throwIfCancelled(ctx.jobId);
                const { done, value } = await reader.read();
                if (done) break;
                if (!value?.byteLength) continue;
                await st.disk.write(st.bytes, value);
                st.bytes += value.byteLength;
                ctx.markProgress();
                ctx.report(0, true);
            }
        } finally {
            try { reader.releaseLock(); } catch (_) {}
        }
        if (!st.bytes || (declared && st.bytes !== declared)) {
            throw new Error(`${label} download incomplete (${st.bytes} of ${declared} bytes)`);
        }
        st.total = st.bytes;
        ctx.report(0, true);
    }

    /** Sequential download, including servers that don't support safe ranges. */
    async function pullSequential(st, baseUrl, label, ctx) {
        while (st.bytes < st.total) {
            throwIfCancelled(ctx.jobId);
            if (ctx.signal.aborted) throw abortError();

            const start = st.bytes;
            const end = Math.min(start + CHUNK_SIZE - 1, st.total - 1);
            const res = await fetchRangeWithRetry(baseUrl, start, end, ctx, label);

            // The server's own size beats the URL's clen (Drive often misreports it).
            if (res.total > 0 && res.total !== st.total) st.total = res.total;

            if (res.whole) {
                await st.disk.reset();
                await st.disk.write(0, res.data);
                st.bytes = res.data.byteLength;
                st.total = res.total;
            } else {
                // A short slice is fine: we simply continue from the new offset.
                await st.disk.write(start, res.data);
                st.bytes += res.data.byteLength;
            }
            ctx.report(0, true);
        }

        if (st.bytes < st.total) {
            throw new Error(`${label} download incomplete (${st.bytes} of ${st.total} bytes)`);
        }
        if (st.bytes > st.total) st.total = st.bytes;
    }

    /** Fetch one fixed-position chunk, including any short partial responses. */
    async function pullParallelChunk(st, baseUrl, label, ctx, index, chunkSize) {
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize - 1, st.total - 1);
        const parts = [];
        let cursor = start;

        while (cursor <= end) {
            const res = await fetchRangeWithRetry(baseUrl, cursor, end, ctx, label);
            if (res.whole) throw rangeUnsupported(`${label} server ignored a range request`);
            if (res.total > 0 && res.total !== st.total) {
                throw new Error(`${label} stream size changed during download; please retry.`);
            }
            if (!res.data.byteLength || res.data.byteLength > end - cursor + 1) {
                throw new Error(`${label} returned an invalid chunk`);
            }
            parts.push(res.data);
            ctx.onPartComplete?.(res.data.byteLength);
            cursor += res.data.byteLength;
        }

        if (parts.length === 1) return parts[0];
        const combined = new Uint8Array(end - start + 1);
        let offset = 0;
        for (const part of parts) {
            combined.set(part, offset);
            offset += part.byteLength;
        }
        return combined;
    }

    /**
     * A small worker pool claims disjoint chunks. Completed chunks stay in the
     * map across manual and automatic restarts; aborted chunks are re-fetched.
     */
    async function pullParallel(st, baseUrl, label, ctx) {
        const requestedWorkers = STREAM_WORKERS[label] || 4;
        // Always request fixed 4 MiB ranges (apart from the final short range).
        // Do not split small audio streams into tiny slices just to fill workers:
        // that can add network overhead without improving transfer speed.
        const chunkSize = CHUNK_SIZE;
        const chunkCount = Math.ceil(st.total / chunkSize);
        const workerCount = Math.min(requestedWorkers, chunkCount);
        if (!st.parallelChunks) st.parallelChunks = new Set();

        // Tell the overlay which byte positions are already complete. A new
        // attempt clears stale active markers but retains finished chunks.
        postStageMessage('videoStageChunkProgress', {
            jobId: ctx.jobId, label, status: 'sync', total: st.total,
            chunkSize, workerCount, completed: [...st.parallelChunks.keys()]
        });

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (ctx.signal.aborted) controller.abort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });

        const inflight = new Map();
        let nextIndex = 0;
        let firstError = null;

        const worker = async workerId => {
            const workerCtx = {
                ...ctx,
                signal: controller.signal,
                strictRange: true,
                rangeMode: st.rangeMode,
                report: bytes => {
                    inflight.set(workerId, bytes);
                    let inProgress = 0;
                    for (const count of inflight.values()) inProgress += count;
                    ctx.report(inProgress);
                }
            };

            try {
                while (nextIndex < chunkCount) {
                    if (controller.signal.aborted) throw abortError();
                    const index = nextIndex++;
                    if (st.parallelChunks.has(index)) continue;

                    const start = index * chunkSize;
                    const end = Math.min(start + chunkSize - 1, st.total - 1);
                    const chunkLength = end - start + 1;
                    const sendChunk = (status, received = 0) => postStageMessage('videoStageChunkProgress', {
                        jobId: ctx.jobId, label, status, index, start, end,
                        total: st.total, received: Math.min(chunkLength, received)
                    });
                    let lastChunkUpdate = 0;
                    let completedPrefix = 0;
                    const chunkCtx = {
                        ...workerCtx,
                        report: bytes => {
                            workerCtx.report(bytes);
                            const now = performance.now();
                            if (bytes > 0 && now - lastChunkUpdate >= 160) {
                                lastChunkUpdate = now;
                                sendChunk('active', completedPrefix + bytes);
                            }
                        },
                        // Short range responses are valid; keep their completed
                        // portion visible when the next sub-range starts.
                        onPartComplete: length => { completedPrefix += length; }
                    };
                    sendChunk('active');
                    const data = await pullParallelChunk(st, baseUrl, label, chunkCtx, index, chunkSize);
                    if (controller.signal.aborted) throw abortError();
                    await st.disk.write(start, data);
                    st.parallelChunks.add(index);
                    st.bytes += data.byteLength;
                    workerCtx.report(0);
                    sendChunk('complete', data.byteLength);
                    ctx.report(0, true);
                }
            } catch (error) {
                if (!firstError) firstError = error;
                controller.abort();
            } finally {
                inflight.delete(workerId);
            }
        };

        try {
            await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
            if (firstError) throw firstError;
            if (st.parallelChunks.size !== chunkCount || st.bytes !== st.total) {
                throw new Error(`${label} download incomplete (${st.bytes} of ${st.total} bytes)`);
            }
            st.parallelChunks = null;
        } finally {
            ctx.signal.removeEventListener('abort', onAbort);
            ctx.report(0, true);
        }
    }

    /** Select parallel requests only when byte-range support was verified. */
    async function pullStream(st, baseUrl, label, ctx) {
        if (!st.probed) {
            const { total, mode } = await probeStream(baseUrl, st.total, ctx);
            st.total = total;
            st.rangeMode = mode;
            st.probed = true;
        }

        if (st.total <= 0) {
            postStageMessage('videoStageChunkProgress', {
                jobId: ctx.jobId, label, status: 'clear', reason: 'File size or byte ranges unavailable'
            });
            return pullWhole(st, baseUrl, label, ctx);
        }
        if (st.rangeMode && st.total >= (STREAM_WORKERS[label] || 4)) {
            try {
                await pullParallel(st, baseUrl, label, ctx);
                return;
            } catch (error) {
                if (error?.name !== 'RangeUnsupportedError') throw error;
                // Don't mix incompatible responses with already-completed chunks.
                st.parallelChunks = null;
                await st.disk.reset();
                st.bytes = 0;
                st.rangeMode = null;
                postStageMessage('videoStageChunkProgress', {
                    jobId: ctx.jobId, label, status: 'clear', reason: 'Server stopped accepting byte ranges'
                });
            }
        }
        if (!st.rangeMode) {
            postStageMessage('videoStageChunkProgress', {
                jobId: ctx.jobId, label, status: 'clear',
                reason: 'Server did not confirm byte-range support'
            });
        }
        if (!st.rangeMode) await pullWhole(st, baseUrl, label, ctx);
        else await pullSequential(st, baseUrl, label, ctx);
    }

    function makeReporter(jobId, label, st) {
        let last = 0;
        return (inflight = 0, force = false) => {
            const now = performance.now();
            if (!force && now - last < 200) return;
            last = now;
            const total = st.total;
            const received = total > 0 ? Math.min(st.bytes + inflight, total) : st.bytes + inflight;
            postStageMessage('videoStageProgress', { jobId, label, received, total: total || received });
        };
    }

    /** One download attempt: own abort controller + stuck watchdog. */
    function beginAttempt(parentSignal, rt) {
        const controller = new AbortController();
        const attempt = {
            controller,
            signal: controller.signal,
            stuck: false,
            manual: false,
            lastProgressAt: Date.now()
        };
        const onParentAbort = () => { try { controller.abort(); } catch (_) {} };
        if (parentSignal) {
            if (parentSignal.aborted) controller.abort();
            else parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
        const watchdog = setInterval(() => {
            if (controller.signal.aborted) return;
            if (Date.now() - attempt.lastProgressAt >= STUCK_MS) {
                attempt.stuck = true;
                try { controller.abort(); } catch (_) {}
            }
        }, 1000);
        attempt.markProgress = () => { attempt.lastProgressAt = Date.now(); };
        rt?.attempts.add(attempt);
        attempt.dispose = () => {
            clearInterval(watchdog);
            parentSignal?.removeEventListener('abort', onParentAbort);
            rt?.attempts.delete(attempt);
        };
        return attempt;
    }

    /** Park a stalled stream until the user presses Restart (or the job ends). */
    function waitForManualRestart(rt, signal) {
        return new Promise((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(abortError()); };
            const waiter = { resolve: () => { cleanup(); resolve(); } };
            const cleanup = () => {
                rt.waiters.delete(waiter);
                signal?.removeEventListener('abort', onAbort);
            };
            if (signal?.aborted) return reject(abortError());
            rt.waiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Download one stream completely. A stall (automatic or user-requested)
     * resumes from the last received byte instead of starting over.
     * Resolves only with a stream whose size matches the expected total.
     */
    async function downloadStream(url, totalHint, label, job, parentSignal, rt) {
        const jobId = job.jobId;
        const baseUrl = cleanStageURL(url);
        const st = {
            bytes: 0, total: Math.max(0, Number(totalHint) || 0),
            probed: false, rangeMode: null, parallelChunks: null,
            disk: await window.GDriveVideoDiskStorage.createStream(jobId, label)
        };
        const report = makeReporter(jobId, label, st);
        let autoRestarts = 0;

        for (;;) {
            throwIfCancelled(jobId);
            const attempt = beginAttempt(parentSignal, rt);
            try {
                await pullStream(st, baseUrl, label, {
                    jobId,
                    signal: attempt.signal,
                    report,
                    markProgress: attempt.markProgress
                });

                if (st.bytes !== st.total || st.bytes <= 0) {
                    throw new Error(`${label} download incomplete (${st.bytes} of ${st.total} bytes)`);
                }
                const blob = await st.disk.finish();
                if (blob.size !== st.bytes) throw new Error(`${label} temporary file was incomplete.`);
                report(0, true);
                return { blob, bytes: st.bytes, total: st.total };
            } catch (err) {
                if (cancelledJobs.has(jobId)) throw abortError();

                if (attempt.manual) {
                    postStageMessage('videoStageStatus', {
                        jobId, stage: 'download', message: `Restarting ${label} download…`
                    });
                    continue;
                }
                if (attempt.stuck) {
                    if (autoRestarts < MAX_STUCK_RESTARTS) {
                        autoRestarts++;
                        postStageMessage('videoStageStatus', {
                            jobId, stage: 'download', message: `Restarting ${label} download…`
                        });
                        continue;
                    }
                    postStageMessage('videoStageStatus', {
                        jobId, stage: 'download', message: `${label} download stalled. Waiting for restart…`
                    });
                    await waitForManualRestart(rt, parentSignal);
                    autoRestarts = 0;
                    continue;
                }
                await st.disk.abort();
                throw err;
            } finally {
                attempt.dispose();
            }
        }
    }

    /** User pressed Restart: abort live attempts / wake stalled streams. They resume, not restart. */
    function requestRestart(jobId) {
        const rt = jobRuntime.get(jobId);
        if (!rt) return false;
        for (const attempt of [...rt.attempts]) {
            attempt.manual = true;
            try { attempt.controller.abort(); } catch (_) {}
        }
        for (const waiter of [...rt.waiters]) waiter.resolve();
        return true;
    }

    async function downloadSourceStreams(job) {
        postStageMessage('videoStageStatus', {
            jobId: job.jobId,
            stage: 'download',
            message: job.mode === 'single'
                ? 'Downloading selected video stream…'
                : 'Downloading selected video and audio streams…'
        });

        const controller = new AbortController();
        jobControllers.set(job.jobId, controller);
        const rt = { attempts: new Set(), waiters: new Set() };
        jobRuntime.set(job.jobId, rt);

        try {
            throwIfCancelled(job.jobId);

            if (job.mode === 'single') {
                const media = await downloadStream(
                    job.mediaUrl, job.mediaBytes || 0, 'video', job, controller.signal, rt
                );
                return { mediaBlob: media.blob, videoBlob: media.blob, audioBlob: null, mediaBlobInfo: media };
            }

            // Both streams must finish (or one must fail) before anything else happens.
            const [video, audio] = await Promise.all([
                downloadStream(job.videoUrl, job.videoBytes || 0, 'video', job, controller.signal, rt),
                downloadStream(job.audioUrl, job.audioBytes || 0, 'audio', job, controller.signal, rt)
            ]);
            return { videoBlob: video.blob, audioBlob: audio.blob, mediaBlob: null, video, audio };
        } catch (error) {
            // One stream failed: stop the other instead of letting it keep downloading.
            try { controller.abort(); } catch (_) {}
            throw error;
        } finally {
            jobRuntime.delete(job.jobId);
            jobControllers.delete(job.jobId);
        }
    }

    function cancel(jobId) {
        if (jobId) cancelledJobs.add(jobId);
        try { jobControllers.get(jobId)?.abort(); } catch (_) {}
        try { window.GDriveVideoProcessor?.cancel(jobId); } catch (_) {}
    }

    async function run(jobId) {
        if (!jobId || activeRuns.has(jobId)) return;

        const promise = (async () => {
            cancelledJobs.delete(jobId);
            try {
                const job = { ...(await getJob(jobId)), jobId };
                await window.GDriveVideoDiskStorage.prepare(jobId);
                const sources = await downloadSourceStreams(job);
                throwIfCancelled(jobId);

                // Final gate: never hand a partial stream to the merger.
                const parts = job.mode === 'single'
                    ? [sources.mediaBlobInfo]
                    : [sources.video, sources.audio];
                for (const part of parts) {
                    if (!part || part.bytes <= 0 || part.bytes !== part.total || part.blob.size !== part.bytes) {
                        throw new Error('A stream did not finish downloading. Please try again.');
                    }
                }

                if (job.mode === 'single') {
                    await window.GDriveVideoProcessor.processSingle(job, sources.mediaBlob);
                } else {
                    // Both streams verified complete → only now start merging.
                    postStageMessage('videoStageStatus', { jobId, stage: 'staged' });
                    await window.GDriveVideoProcessor.process(job, sources.videoBlob, sources.audioBlob);
                }
            } catch (error) {
                await window.GDriveVideoDiskStorage.remove(jobId).catch(() => {});
                const outOfSpace = error?.name === 'QuotaExceededError'
                    || /quota exceeded|disk full|not enough space/i.test(String(error?.message || ''));
                postStageMessage(isAbortError(error, jobId) ? 'videoStageCancelled' : 'videoStageError', {
                    jobId,
                    message: outOfSpace
                        ? 'Not enough temporary disk storage. Free up disk space and retry.'
                        : error?.message || String(error)
                });
            } finally {
                cancelledJobs.delete(jobId);
            }
        })();

        activeRuns.set(jobId, promise);
        try {
            await promise;
        } finally {
            if (activeRuns.get(jobId) === promise) activeRuns.delete(jobId);
        }
    }

    /**
     * Restart request from the overlay.
     *  - Live download: abort the stalled requests; each stream resumes from its last byte.
     *  - No live run (offscreen document was recreated): start the job again from scratch.
     */
    function restart(jobId) {
        if (!jobId) return;
        if (activeRuns.has(jobId)) {
            if (requestRestart(jobId)) postStageMessage('videoStageRestarted', { jobId, reset: false });
            return;
        }
        postStageMessage('videoStageRestarted', { jobId, reset: true });
        run(jobId);
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.target !== 'video-offscreen') return;
        if (message.type === 'videoStageStart') {
            if (!message.jobId) return sendResponse?.({ accepted: false });
            // Acknowledge delivery immediately. The download itself reports its
            // lifecycle separately, including any errors from getJob/fetch/remux.
            sendResponse?.({ accepted: true });
            void run(message.jobId);
            return;
        }
        if (message.type === 'videoStageCancelInternal') cancel(message.jobId);
        if (message.type === 'videoStageRestartInternal') restart(message.jobId);
        sendResponse?.({ accepted: true });
    });

    window[NS] = { postStageMessage, throwIfCancelled, cancel };
})();
