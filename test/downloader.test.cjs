const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {setTimeout:delay} = require('node:timers/promises');
const {mp4}=require('../test-support/media.cjs');
const media=fs.readFileSync(path.join(__dirname, '../src/offscreen/video-stage-media.js'), 'utf8');
const shared = fs.readFileSync(path.join(__dirname, '../src/shared/stream-url.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/offscreen/video-stage-downloader.js'), 'utf8');
const abortError = () => Object.assign(new Error('Aborted'), {name:'AbortError'});
function deferred() { let resolve; const promise=new Promise(done => { resolve=done; }); return {promise,resolve}; }

function harness({job={}, fetch, createStream, refresh}={}) {
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
            if (message.type === 'refreshVideoStageStreams') return Promise.resolve(refresh ? refresh(message) : {success:false});
            if (['videoStageError','videoStageCancelled'].includes(message.type)) done.resolve(message);
            return Promise.resolve();
        }
    }};
    vm.runInNewContext(shared + '\n' + media + '\n' + source,{window,chrome,fetch,URL,Blob,Uint8Array,TextDecoder,AbortController,performance,setTimeout,clearTimeout,setInterval,clearInterval});
    function send(type) { listener({target:'video-offscreen',type,jobId:job.jobId},null,()=>{}); }
    return {start() { send('videoStageStart'); return done.promise; },cancel() { send('videoStageCancelInternal'); },restart() { send('videoStageRestartInternal'); },messages,disks,get removed() {return removed;}};
}

test('streams a complete non-ranged file to disk before saving', {timeout:3000}, async () => {
    const bytes=mp4();
    const h=harness({fetch:async () => new Response(bytes,{headers:{'content-length':String(bytes.length)}})});
    const result=await h.start();
    assert.equal(result.type,'saved');
    assert.deepEqual(Buffer.from(await result.video.arrayBuffer()),bytes);
    assert.equal(h.disks.get('video').closed,true);
});

test('parallel ranges and short slices produce the exact original bytes', {timeout:5000}, async () => {
    const bytes=mp4({payloadBytes:9*1024*1024+17});
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
    const bytes=mp4();
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
    const h=harness({fetch:async () => new Response(Buffer.from('short'),{headers:{'content-length':'100'}})});
    const result=await h.start();
    assert.equal(result.type,'videoStageError');
    assert.match(result.message,/incomplete/);
    assert.equal(h.disks.get('video').closed,true);
    assert.equal(h.removed,true);
});

test('player UMP URLs are normalized to raw tracks before network requests', {timeout:3000}, async () => {
    const bytes=mp4();
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

test('a tiny audio response cannot replace the expected whole-track size', {timeout:3000}, async () => {
    const video=mp4(), audio=mp4({kind:'audio'});
    const h=harness({job:{mode:'adaptive',videoBytes:video.length,audioBytes:100000},fetch:async(url,options)=>{
        if(options.headers)return new Response(null,{status:400});
        const body=url.includes('/audio')?audio:video;
        return new Response(body,{headers:{'content-length':String(body.length)}});
    }});
    const result=await h.start();
    assert.equal(result.type,'videoStageError');assert.match(result.message,/audio download incomplete/);
    assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'||m.stage==='staged'),false);
});
test('a successful HTML response is rejected instead of becoming an audio file', {timeout:3000}, async () => {
    const h=harness({fetch:async()=>new Response('<html>Sign in again</html>',{headers:{'content-type':'text/html'}})});
    const result=await h.start();assert.equal(result.type,'videoStageError');assert.match(result.message,/non-media/);
    assert.equal(h.disks.get('video').bytes.length,0);
});
test('initialization-only MP4 and truncated boxes never reach processing', {timeout:3000}, async () => {
    for(const bytes of [mp4({headerOnly:true}),mp4().subarray(0,-2)]) {
        const h=harness({fetch:async()=>new Response(bytes)});const result=await h.start();
        assert.equal(result.type,'videoStageError');assert.match(result.message,/not a complete MP4/);
        assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'),false);
    }
});
test('unknown totals are not invented from bytes received before EOF', {timeout:3000}, async () => {
    const bytes=mp4(), gate=deferred(), reading=deferred();let phase=0;
    const h=harness({fetch:async(_url,options)=>{
        if(options.headers)return new Response(null,{status:400});
        return new Response(new ReadableStream({async pull(controller){
            if(phase++===0){controller.enqueue(bytes.subarray(0,40));reading.resolve();}
            else {await gate.promise;controller.enqueue(bytes.subarray(40));controller.close();}
        }}));
    }});
    const done=h.start();await reading.promise;await delay(10);
    const progress=h.messages.filter(m=>m.type==='videoStageProgress');
    assert.ok(progress.length);assert.ok(progress.every(m=>m.total===0&&!m.complete));
    assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'),false);
    gate.resolve();assert.equal((await done).type,'saved');
    assert.ok(h.messages.some(m=>m.type==='videoStageProgress'&&m.complete));
});
test('processing waits until both tracks finish and their media is validated', {timeout:3000}, async () => {
    const gate=deferred(),video=mp4(),audio=mp4({kind:'audio'});
    const h=harness({job:{mode:'adaptive'},fetch:async(url,options)=>{
        if(options.headers)return new Response(null,{status:400});
        if(url.includes('/audio'))await gate.promise;
        return new Response(url.includes('/audio')?audio:video);
    }});
    const done=h.start();for(let i=0;i<100&&!h.messages.some(m=>m.label==='video'&&m.complete);i++)await delay(5);
    assert.ok(h.messages.some(m=>m.label==='video'&&m.complete));
    assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'||m.stage==='staged'),false);
    gate.resolve();assert.equal((await done).type,'saved');
    const gateIndex=h.messages.findIndex(m=>m.type==='videoStageSourcesReady');
    const stageIndex=h.messages.findIndex(m=>m.stage==='staged');assert.ok(gateIndex>=0&&stageIndex>gateIndex);
});
test('wrong-kind and mismatched-duration tracks are rejected before merging', {timeout:3000}, async () => {
    for(const audio of [mp4({kind:'video'}),mp4({kind:'audio',duration:1})]) {
        const h=harness({job:{mode:'adaptive'},fetch:async(url,options)=>{
            if(options.headers)return new Response(null,{status:400});
            return new Response(url.includes('/audio')?audio:mp4({duration:60}));
        }});
        assert.equal((await h.start()).type,'videoStageError');
        assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'),false);
    }
});

test('a non-media header probe falls back to a valid query request', {timeout:3000}, async()=>{
    const bytes=mp4();
    const h=harness({job:{mediaBytes:bytes.length},fetch:async(url,options)=>{
        if(options.headers?.Range)return new Response('<html>temporary failure</html>',{headers:{'content-type':'text/html'}});
        const range=new URL(url).searchParams.get('range').split('-').map(Number);
        return new Response(bytes.subarray(range[0],range[1]+1),{headers:{'content-type':'video/mp4','content-length':String(range[1]-range[0]+1)}});
    }});
    assert.equal((await h.start()).type,'saved');assert.equal(h.messages.some(m=>m.type==='refreshVideoStageStreams'),false);
});
test('a trusted text media redirect is followed without counting it as downloaded bytes', {timeout:3000}, async()=>{
    const bytes=mp4();let redirects=0;
    const h=harness({job:{mediaUrl:'https://source.googlevideo.com/videoplayback',mediaBytes:bytes.length},fetch:async(url,options)=>{
        if(new URL(url).hostname==='source.googlevideo.com'){redirects++;return new Response('https://destination.googlevideo.com/videoplayback',{headers:{'content-type':'text/plain'}});}
        const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range);const start=Number(match[1]),end=Number(match[2]);
        return new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes '+start+'-'+end+'/'+bytes.length}});
    }});
    assert.equal((await h.start()).type,'saved');assert.ok(redirects>0);
    assert.ok(h.messages.filter(m=>m.type==='videoStageProgress').every(m=>m.received<=bytes.length));
});
test('text bodies cannot redirect the downloader to an unrelated host', {timeout:3000}, async()=>{
    let unrelated=0;const h=harness({fetch:async(url)=>{if(url.includes('unrelated.example'))unrelated++;return new Response('https://unrelated.example/videoplayback',{headers:{'content-type':'text/plain'}});}});
    assert.equal((await h.start()).type,'videoStageError');assert.equal(unrelated,0);
});
test('a failed source is recaptured once and can finish without a page refresh', {timeout:3000}, async()=>{
    const bytes=mp4();let refreshes=0;
    const h=harness({job:{mode:'adaptive',videoBytes:bytes.length,audioBytes:bytes.length},refresh:()=>{refreshes++;return {success:true,videoUrl:'https://example.com/fresh-video',audioUrl:'https://example.com/fresh-audio',videoBytes:bytes.length,audioBytes:bytes.length};},fetch:async(url,options)=>{
        if(!url.includes('/fresh-'))return new Response('<html>expired source</html>',{headers:{'content-type':'text/html'}});
        if(options.headers)return new Response(null,{status:400});
        return new Response(url.includes('audio')?mp4({kind:'audio'}):bytes);
    }});
    const result=await h.start();assert.equal(result.type,'saved');assert.ok(refreshes>=1&&refreshes<=2);
});
test('persistent non-media responses stop after one recapture per stream', {timeout:3000}, async()=>{
    let refreshes=0;const h=harness({refresh:()=>{refreshes++;return {success:true,videoUrl:'https://example.com/still-invalid'};},fetch:async()=>new Response('<html>still invalid</html>',{headers:{'content-type':'text/html'}})});
    assert.equal((await h.start()).type,'videoStageError');assert.equal(refreshes,1);assert.equal(h.messages.some(m=>m.type==='videoStageSourcesReady'),false);
});
