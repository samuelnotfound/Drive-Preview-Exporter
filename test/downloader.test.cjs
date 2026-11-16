const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {setTimeout:delay} = require('node:timers/promises');
const shared = fs.readFileSync(path.join(__dirname, '../src/shared/stream-url.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/offscreen/video-stage-downloader.js'), 'utf8');
const abortError = () => Object.assign(new Error('Aborted'), {name:'AbortError'});
function deferred() { let resolve; const promise=new Promise(done => { resolve=done; }); return {promise,resolve}; }

function harness({job={}, fetch, createStream}={}) {
    job={jobId:'test-job', mode:'single', mediaUrl:'https://example.com/video', videoUrl:'https://example.com/video', audioUrl:'https://example.com/audio', ...job};
    let listener;
    const done=deferred();
    const messages=[];
    const disks=new Map();
    let removed=false;
    const storage={
        async prepare() {},
        async createStream(jobId,label) {
            await createStream?.(label);
            const disk={closed:false, bytes:Buffer.alloc(0)};
            disks.set(label,disk);
            return {
                async write(position,bytes) {
                    assert.equal(disk.closed,false);
                    if (position+bytes.length>disk.bytes.length) { const next=Buffer.alloc(position+bytes.length); disk.bytes.copy(next); disk.bytes=next; }
                    disk.bytes.set(bytes,position);
                },
                async reset() { disk.bytes=Buffer.alloc(0); },
                async finish() { disk.closed=true; return new Blob([disk.bytes]); },
                async abort() { disk.closed=true; }
            };
        },
        async remove() { removed=true; for (const disk of disks.values()) assert.equal(disk.closed,true,'cleanup must wait for all disk writers'); }
    };
    const window={GDriveVideoDiskStorage:storage, GDriveVideoProcessor:{
        async processSingle(_job,blob) { done.resolve({type:'saved', video:blob}); },
        async process(_job,video,audio) { done.resolve({type:'saved', video,audio}); },
        cancel() {}
    }};
    const chrome={runtime:{
        onMessage:{addListener(fn) { listener=fn; }},
        sendMessage(message,callback) {
            if (callback) { callback({job}); return; }
            messages.push(message);
            if (['videoStageError','videoStageCancelled'].includes(message.type)) done.resolve(message);
            return Promise.resolve();
        }
    }};
    vm.runInNewContext(shared + '\n' + source,{window,chrome,fetch,URL,Blob,Uint8Array,AbortController,performance,setTimeout,clearTimeout,setInterval,clearInterval});
    function send(type) { listener({target:'video-offscreen',type,jobId:job.jobId},null,()=>{}); }
    return {start() { send('videoStageStart'); return done.promise; },cancel() { send('videoStageCancelInternal'); },restart() { send('videoStageRestartInternal'); },messages,disks,get removed() {return removed;}};
}

test('streams a complete non-ranged file to disk before saving', {timeout:3000}, async () => {
    const bytes=Buffer.from('a complete progressive video');
    const h=harness({fetch:async () => new Response(bytes,{headers:{'content-length':String(bytes.length)}})});
    const result=await h.start();
    assert.equal(result.type,'saved');
    assert.deepEqual(Buffer.from(await result.video.arrayBuffer()),bytes);
    assert.equal(h.disks.get('video').closed,true);
});

test('parallel ranges and short slices produce the exact original bytes', {timeout:5000}, async () => {
    const bytes=Buffer.alloc(9*1024*1024+17);
    for (let i=0;i<bytes.length;i++) bytes[i]=i%251;
    let requests=0;
    const h=harness({job:{mediaBytes:bytes.length},fetch:async (_url,options) => {
        const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start=Number(match[1]);
        const end=Math.min(Number(match[2]),start+1024*1024-1);
        requests++;
        return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});
    }});
    const result=await h.start();
    assert.equal(result.type,'saved');
    assert.deepEqual(Buffer.from(await result.video.arrayBuffer()),bytes);
    assert.ok(requests>4,'short slices must be continued');
});

test('falls back to a whole stream if the server stops honoring ranges', {timeout:3000}, async () => {
    const bytes=Buffer.from('the complete stream');
    const h=harness({job:{mediaBytes:bytes.length},fetch:async (_url,options) => {
        if (options.headers?.Range==='bytes=0-0') return new Response(bytes.subarray(0,1),{status:206,headers:{'content-range':`bytes 0-0/${bytes.length}`}});
        return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
    }});
    const result=await h.start();
    assert.equal(result.type,'saved');
    assert.deepEqual(Buffer.from(await result.video.arrayBuffer()),bytes);
});

test('a failed stream waits for its aborted sibling before deleting temporary files', {timeout:3000}, async () => {
    const reading=deferred();
    let audioAborted=false;
    const h=harness({job:{mode:'adaptive'},fetch:async (url,options) => {
        if (url.includes('/video')) { await reading.promise; return new Response(null,{status:403}); }
        // Probes are rejected; the full audio request stays pending until abort.
        if (options.headers) return new Response(null,{status:400});
        reading.resolve();
        return {ok:true,headers:new Headers(),body:{getReader() { return {
            async read() {
                if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort',resolve,{once:true}));
                await delay(30);
                audioAborted=true;
                throw abortError();
            },
            releaseLock() {}
        }; }}};
    }});
    const result=await h.start();
    assert.equal(result.type,'videoStageError');
    assert.match(result.message,/403/);
    assert.equal(audioAborted,true);
    assert.equal(h.removed,true);
    assert.ok([...h.disks.values()].every(disk => disk.closed));
});

test('cancelling while temporary storage opens still closes its writer', {timeout:3000}, async () => {
    const opening=deferred();
    const release=deferred();
    let requests=0;
    const h=harness({createStream:async () => { opening.resolve(); await release.promise; },fetch:async () => {requests++;throw new Error('Unexpected network request');}});
    const resultPromise=h.start();
    await opening.promise;
    h.cancel();
    release.resolve();
    const result=await resultPromise;
    assert.equal(result.type,'videoStageCancelled');
    assert.equal(requests,0);
    assert.equal(h.disks.get('video').closed,true);
    assert.equal(h.removed,true);
});

test('an interrupted response is never handed to the MP4 processor', {timeout:3000}, async () => {
    const h=harness({fetch:async () => new Response('short',{headers:{'content-length':'100'}})});
    const result=await h.start();
    assert.equal(result.type,'videoStageError');
    assert.match(result.message,/incomplete/);
    assert.equal(h.disks.get('video').closed,true);
    assert.equal(h.removed,true);
});

test('player UMP URLs are normalized to raw tracks before network requests', {timeout:3000}, async () => {
    const bytes=Buffer.from('a raw media track');
    const h=harness({job:{mediaUrl:'https://example.com/video?ump=1&range=3-9&sig=a%2fb%20c+z',mediaBytes:bytes.length},fetch:async (url,options) => {
        assert.equal(new URL(url).searchParams.has('ump'),false);
        assert.ok(url.includes('sig=a%2fb%20c+z'),'signed query encoding must survive normalization');
        const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start=Number(match[1]),end=Number(match[2]);
        return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-type':'video/mp4'}});
    }});
    const result=await h.start();
    assert.equal(result.type,'saved');
    assert.deepEqual(Buffer.from(await result.video.arrayBuffer()),bytes);
});

test('unexpected player transport is rejected before writing or merging it', {timeout:3000}, async () => {
    const h=harness({fetch:async () => new Response('player transport',{headers:{'content-type':'application/vnd.yt-ump'}})});
    const result=await h.start();
    assert.equal(result.type,'videoStageError');
    assert.match(result.message,/player transport/);
    assert.equal(h.disks.get('video').bytes.length,0);
    assert.equal(h.disks.get('video').closed,true);
    assert.equal(h.removed,true);
});
