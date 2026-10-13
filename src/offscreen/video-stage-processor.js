
(() => {
    const downloader = window.GDriveVideoStreamDownloader;
    const workers = new Map();
    const rejects = new Map();
    const pendingSaves = new Map();

    /** If the worker goes this long without posting anything at all, treat it as wedged. */
    const WORKER_IDLE_TIMEOUT_MS = 120000;

    function cancel(jobId) {
        if (jobId) {
            try { workers.get(jobId)?.terminate(); } catch (_) {}
            workers.delete(jobId);
            rejects.get(jobId)?.(Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }));
            rejects.delete(jobId);
            return;
        }
        for (const id of [...workers.keys()]) cancel(id);
    }

    async function mergeStreams(job, videoBlob, audioBlob) {
        const worker = new Worker(chrome.runtime.getURL('vendor/mp4-remux-worker.js'));
        workers.set(job.jobId, worker);

        let idleTimer = null;
        try {
            return await new Promise((resolve, reject) => {
                rejects.set(job.jobId, reject);
                let lastMsgAt = Date.now();

                const armIdleWatchdog = () => {
                    clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => {
                        if (Date.now() - lastMsgAt < WORKER_IDLE_TIMEOUT_MS) return armIdleWatchdog();
                        reject(new Error('Merging stalled and was stopped. Please try downloading again.'));
                    }, WORKER_IDLE_TIMEOUT_MS);
                };
                armIdleWatchdog();

                worker.onmessage = event => {
                    lastMsgAt = Date.now();
                    const data = event.data || {};
                    if (data.type === 'status') return;
                    if (data.type === 'ffmpeg-progress') {
                        downloader.postStageMessage('videoStageMergeProgress', {
                            jobId: job.jobId,
                            progress: Math.max(0, Math.min(1, Number(data.progress) || 0)),
                            mergeTimeUs: Number(data.time) || 0,
                            mergeDurationUs: Number(data.duration) || 0,
                            frame: Number(data.frame) || 0
                        });
                        return;
                    }
                    if (data.type === 'done') {
                        if (!data.size) return reject(new Error('The merged MP4 was empty.'));
                        resolve(data.size);
                        return;
                    }
                    if (data.type === 'error') reject(new Error(data.message || 'Remux failed.'));
                };

                worker.onerror = event => reject(new Error(event.message || 'Remux worker failed.'));
                worker.postMessage({
                    type: 'mux',
                    video: videoBlob,
                    audio: audioBlob,
                    jobId: job.jobId
                });
            });
        } finally {
            clearTimeout(idleTimer);
            rejects.delete(job.jobId);
            try { worker.terminate(); } catch (_) {}
            if (workers.get(job.jobId) === worker) workers.delete(job.jobId);
        }
    }

    /** Chrome saves the disk-backed File URL and confirms the download's final state. */
    async function saveFile(file, filename, jobId) {
        const url = URL.createObjectURL(file);
        pendingSaves.set(jobId, url);
        try {
            const reply = await chrome.runtime.sendMessage({
                type: 'videoStageSaveReady', jobId, url, filename
            });
            if (!reply?.success) throw new Error(reply?.error || 'Chrome could not start saving the file.');
            downloader.postStageMessage('videoStageDownloadStarted', { jobId });
        } catch (error) {
            URL.revokeObjectURL(url);
            pendingSaves.delete(jobId);
            throw error;
        }
    }

    async function process(job, videoBlob, audioBlob) {
        downloader.throwIfCancelled(job.jobId);
        if (!videoBlob?.size || !audioBlob?.size) {
            throw new Error('Cannot merge: video or audio is missing.');
        }
        await mergeStreams(job, videoBlob, audioBlob);
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing' });
        const file = await window.GDriveVideoDiskStorage.outputFile(job.jobId);
        await saveFile(file, job.filename, job.jobId);
        // Do not mark Finished until chrome.downloads reports completion.
    }

    async function processSingle(job, mediaFile) {
        downloader.throwIfCancelled(job.jobId);
        downloader.postStageMessage('videoStageStatus', { jobId: job.jobId, stage: 'processing' });
        await saveFile(mediaFile, job.filename, job.jobId);
    }

    // Keep the URL and temporary files alive while Chrome copies the download.
    chrome.runtime.onMessage.addListener(message => {
        if (message?.target !== 'video-offscreen' || message.type !== 'videoStageSaveCompleteInternal') return;
        const url = pendingSaves.get(message.jobId);
        if (url) URL.revokeObjectURL(url);
        pendingSaves.delete(message.jobId);
        void window.GDriveVideoDiskStorage.remove(message.jobId).catch(() => {});
    });

    window.GDriveVideoProcessor = { process, processSingle, cancel };
})();
