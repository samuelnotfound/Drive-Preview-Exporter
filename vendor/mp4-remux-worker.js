/** Merge disk-backed source Files into a disk-backed MP4 without creating a final-size Blob. */
importScripts('mp4-remux.iife.js');

function trackedStream(file, onBytes) {
    const reader = file.stream().getReader();
    let received = 0;
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            received += value.byteLength;
            onBytes(received);
            controller.enqueue(value);
        },
        cancel() { return reader.cancel(); }
    });
}

self.onmessage = async ({ data }) => {
    if (data?.type !== 'mux') return;
    let writer;
    try {
        const { video, audio, jobId } = data;
        if (!(video instanceof Blob) || !(audio instanceof Blob)) {
            throw new Error('Both video and audio files are required for merging.');
        }
        const root = await navigator.storage.getDirectory();
        const workspace = await root.getDirectoryHandle('drive-preview-exporter-temp');
        const jobDirectory = await workspace.getDirectoryHandle(jobId.replace(/[^a-zA-Z0-9_-]/g, '_'));
        const output = await jobDirectory.getFileHandle('output.mp4', { create: true });
        writer = await output.createWritable({ keepExistingData: false });

        let videoRead = 0, audioRead = 0, lastProgress = 0;
        const total = video.size + audio.size;
        const report = () => {
            if (Date.now() - lastProgress < 350) return;
            lastProgress = Date.now();
            postMessage({ type: 'ffmpeg-progress', progress: total ? (videoRead + audioRead) / total : 0 });
        };
        const combined = await self.mp4Remux(
            trackedStream(video, n => { videoRead = n; report(); }),
            trackedStream(audio, n => { audioRead = n; report(); })
        );
        if (!combined?.getReader) throw new Error('MP4 merger did not return a stream.');
        // FileSystemWritableFileStream accepts Uint8Arrays and applies write backpressure.
        await combined.pipeTo(writer);
        writer = null;
        const file = await output.getFile();
        if (!file.size) throw new Error('The merged MP4 was empty.');
        postMessage({ type: 'ffmpeg-progress', progress: 1 });
        postMessage({ type: 'done', size: file.size });
    } catch (error) {
        try { await writer?.abort(); } catch (_) {}
        postMessage({ type: 'error', message: error?.message || String(error) });
    }
};
