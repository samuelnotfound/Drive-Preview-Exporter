const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../src/background/video-jobs.js'),'utf8');
function harness(capture){
    const job={jobId:'job',mode:'adaptive',sourceTabId:1,fileId:'test-file',viewerSessionId:'test-viewer',videoUrl:'https://example.com/video',audioUrl:'https://example.com/audio',filename:'test.mp4'};
    const jobs={job};const session={fileId:job.fileId,viewerSessionId:job.viewerSessionId};let calls=0;
    const context=vm.createContext({getStoredJobs:async()=>jobs,getStoredSession:async()=>session,queueJobMutation:async fn=>fn(jobs),parseStreamCandidate:()=>({height:720}),cleanURL:url=>url,getStreamBytes:()=>100,handleCaptureQualityForDownload:async args=>{calls++;assert.equal(args.request.forceFresh,true);return capture?capture():{success:true,video:{url:'https://example.com/fresh-video',contentLength:100},audio:{url:'https://example.com/fresh-audio',contentLength:100}};}});
    vm.runInContext(source,context);
    return {jobs,session,get calls(){return calls;},refresh:()=>context.refreshVideoStageStreams({request:{jobId:'job'}})};
}
test('simultaneous stream refresh requests share one player recapture',async()=>{
    let release;const pending=new Promise(resolve=>release=resolve);
    const h=harness(async()=>{await pending;return {success:true,video:{url:'https://example.com/fresh-video'},audio:{url:'https://example.com/fresh-audio'}};});
    const first=h.refresh(),second=h.refresh();assert.equal(first,second);release();
    assert.equal((await first).success,true);assert.equal(h.calls,1);assert.equal(h.jobs.job.audioUrl,'https://example.com/fresh-audio');
});
test('a refresh cannot replace tracks after the viewer changes',async()=>{
    const h=harness();h.session.fileId='different-file';
    assert.equal((await h.refresh()).success,false);assert.equal(h.calls,0);assert.equal(h.jobs.job.videoUrl,'https://example.com/video');
});
test('a recapture does not recreate a job cancelled while it was waiting',async()=>{
    let release;const pending=new Promise(resolve=>release=resolve);
    const h=harness(async()=>{await pending;return {success:true,video:{url:'https://example.com/fresh-video'},audio:{url:'https://example.com/fresh-audio'}};});
    const result=h.refresh();for(let i=0;i<5&&!h.calls;i++)await Promise.resolve();delete h.jobs.job;release();
    assert.equal((await result).success,false);assert.equal(h.jobs.job,undefined);
});
