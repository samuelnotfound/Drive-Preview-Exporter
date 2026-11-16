const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {test}=require('node:test');
const root=path.resolve(__dirname,'..');const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const code=decodeURIComponent(/id="bm" href="javascript:([^"]+)"/.exec(html)[1]);
function run({title='file.pdf - Google Drive',mime='',host='drive.google.com',pathname='/file/d/test/view',player=false}={}){
    const alerts=[];let created=0;const window={};
    const document={title,querySelector(selector){if(selector==='#drive-active-item-info')return mime?{textContent:JSON.stringify({mimeType:mime})}:null;if(selector==='video,audio,iframe[src*="youtube" i]')return player?{getBoundingClientRect:()=>({width:600,height:400})}:null;return null;},createElement(){created++;throw new Error('capture-started');}};
    try{vm.runInNewContext(code,{window,document,location:{hostname:host,pathname},alert:m=>alerts.push(m),setTimeout(){}});}catch(e){if(e.message!=='capture-started')throw e;}
    return{alerts,created,running:window.__dpeRunning};
}
test('bookmarklet refuses video and audio before scanning or drawing pages',()=>{
    for(const options of[{title:'lecture.mp4 - Google Drive'},{mime:'video/mp4'},{title:'lecture.pdf - Google Drive',player:true},{mime:'audio/mp4'}]){const result=run(options);assert.equal(result.created,0);assert.equal(result.running,undefined);assert.match(result.alerts[0],/only on document previews/);}
});
test('bookmarklet accepts PDF and supported document previews',()=>{
    for(const options of[{},{title:'notes.docx - Google Drive'},{title:'lecture',mime:'application/pdf'},{title:'notes',host:'docs.google.com',pathname:'/document/d/test/edit'}]){const result=run(options);assert.equal(result.alerts.length,0);assert.equal(result.running,true);assert.equal(result.created,1);}
});
test('bookmarklet refuses unrelated pages and image previews',()=>{
    for(const options of[{host:'example.com'},{title:'photo.png - Google Drive',mime:'image/png'}]){const result=run(options);assert.equal(result.created,0);assert.equal(result.alerts.length,1);}
});
