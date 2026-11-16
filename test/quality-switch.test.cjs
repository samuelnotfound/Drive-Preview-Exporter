const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const router = read('src/background/message-router.js');
const start = router.indexOf('async function handleCaptureQualityForDownload(');
const captureSource = router.slice(start, router.indexOf('\n}', start) + 2);
const catalog = read('src/shared/stream-url.js') + '\n' + read('src/background/format-catalog.js');
const stream = (itag, extra = {}) => ({url: `https://media.googlevideo.com/videoplayback?itag=${itag}&clen=100`, itag: String(itag), capturedAt: 9000, ...extra});

function captureHarness({fresh, cached = [], audio = stream(140), changeViewer = false} = {}) {
    let now = 10000, active = null;
    const events = [];
    const session = {fileId: 'file', viewerSessionId: 'viewer', formats: {video: [], audio: []}, videoCandidates: []};
    const state = {recentStreams: cached, probeBuffer: []};
    const context = vm.createContext({URL, Map, Set, Date: {now: () => now},
        sleep: async ms => { now += ms; }, QUALITY_SCAN_TAB_LOCK: new Map(),
        getSessionForFile: async () => ({session, fileId: 'file'}),
        getStoredSession: async () => session,
        streamCaptureState: () => state,
        closePlayerMenu: async () => {}, runQualityDom: async () => [],
        beginQualityProbe: async () => { events.push('probe'); active = {token: 'probe', accepted: true}; state.probeBuffer = []; return active; },
        endQualityProbe: async () => { active = null; },
        selectQualityVerified: async () => {
            events.push('click');
            if (fresh) {
                const candidate = {...fresh, capturedAt: now, ...(active ? {probeToken: active.token} : {})};
                state.recentStreams = [candidate, ...state.recentStreams];
                if (active) state.probeBuffer.push(candidate);
            }
            if (changeViewer) session.viewerSessionId = 'new-viewer';
            return {ok: true};
        },
        nudgePlaybackAfterQualitySwitch: async () => { events.push('nudge'); },
        getCurrentSessionAudioCandidate: async () => audio,
        lockSharedAudioOnSession: async () => {},
        queueSessionMutation: async (_tabId, fn) => fn(session),
        sessionChangedResponse: () => ({success: false, error: 'Session changed'})
    });
    vm.runInContext(catalog + '\n' + read('src/background/quality-scan.js') + '\n' + captureSource, context);
    return {events, state, session, capture: request => context.handleCaptureQualityForDownload({tabId: 1, request: {fileId: 'file', qualityHeight: 360, qualityLabel: '360p', ...request}})};
}

test('quality capture starts its probe before selecting the new resolution', async () => {
    const h = captureHarness({fresh: stream(134, {height: 360})});
    assert.equal((await h.capture()).success, true);
    assert.ok(h.events.indexOf('probe') < h.events.indexOf('click'));
});

test('switching to 360p never falls back to the previous 720p request', async () => {
    const h = captureHarness({fresh: stream(136, {height: 720}), cached: [stream(136, {height: 720})]});
    assert.equal((await h.capture()).success, false);
});

test('a stale unknown-height probe result cannot stand in for the requested resolution', async () => {
    const h = captureHarness({cached: [stream('unknown', {height: 360, heightSource: 'probe', probeToken: 'old-probe'})]});
    assert.equal((await h.capture()).success, false);
});

test('a fresh matching video can reuse same-session audio when quality switching does not request audio', async () => {
    const h = captureHarness({fresh: stream(134, {height: 360})});
    const result = await h.capture({forceFresh: true});
    assert.equal(result.success, true);
    assert.ok(result.audio?.url);
});

test('stream capture is rejected if the viewer changes during quality selection', async () => {
    const h = captureHarness({fresh: stream(134, {height: 360}), changeViewer: true});
    assert.equal((await h.capture()).success, false);
});

test('fresh-source recovery does not reuse a cached video of the requested quality', async () => {
    const h = captureHarness({cached: [stream(134, {height: 360})]});
    assert.equal((await h.capture({forceFresh: true})).success, false);
});

function jobsHarness() {
    const jobs = {};
    const session = {fileId: 'file', viewerSessionId: 'viewer', formats: {video: [], audio: [], progressive: []}};
    const context = vm.createContext({URL, Map, Set, Date, Math,
        getStoredSession: async () => session,
        getStoredJobs: async () => jobs,
        queueJobMutation: async fn => fn(jobs),
        chrome: {runtime: {getURL: url => url, getContexts: async () => [{}]}},
        sendTab: async () => {},
        streamCaptureState: () => ({recentStreams: []})
    });
    vm.runInContext(catalog + '\n' + read('src/background/video-jobs.js'), context);
    return {context, jobs, session};
}

test('a captured progressive 360p URL downloads once without an extra audio track', async () => {
    const h = jobsHarness();
    const response = await h.context.startVideoDownload(1, {qualityHeight: 360, videoUrl: stream(18).url, audioUrl: stream(140).url});
    assert.equal(response.success, true);
    assert.equal(h.jobs[response.jobId].mode, 'single');
    assert.equal(h.jobs[response.jobId].qualityHeight, 360);
    assert.equal(h.jobs[response.jobId].audioUrl, null);
});

test('job creation rejects a URL whose known resolution contradicts the selection', async () => {
    const h = jobsHarness();
    const response = await h.context.startVideoDownload(1, {qualityHeight: 360, videoUrl: stream(136).url, audioUrl: stream(140).url});
    assert.equal(response.success, false);
    assert.equal(Object.keys(h.jobs).length, 0);
});

test('pool selection never substitutes another quality when the requested resolution is absent', () => {
    const h = jobsHarness();
    h.session.formats.video = [stream(136, {height: 720})];
    assert.equal(h.context.pickVideoFromPools(h.session, {qualityHeight: 360}, 1), null);
});


test('a progressive job recaptures the selected quality without requiring a separate audio request', async () => {
    const h = jobsHarness();
    const started = await h.context.startVideoDownload(1, {qualityHeight: 360, videoUrl: stream(18).url});
    let selectedHeight;
    h.context.handleCaptureQualityForDownload = async ({request}) => {
        selectedHeight = request.qualityHeight;
        return {success: true, video: stream(18, {height: 360, qualityHeight: 360}), audio: null};
    };
    const result = await h.context.refreshVideoStageStreams({request: {jobId: started.jobId}});
    assert.equal(result.success, true);
    assert.equal(selectedHeight, 360);
    assert.equal(result.mediaUrl, stream(18).url);
    assert.equal(result.audioUrl, undefined);
});
