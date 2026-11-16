const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../src/content/drive/video-overlay.js'),'utf8');
function harness() {
    const nodes=new Map();const sent=[];let tick;let now=1000;
    function element() {
        const classes=new Set(),attributes=new Map();
        return {style:{},textContent:'',disabled:false,children:[],classList:{add(...items){items.forEach(i=>classes.add(i));},remove(...items){items.forEach(i=>classes.delete(i));},contains(item){return classes.has(item);}},
            set innerHTML(html){for(const [,id] of html.matchAll(/id="([^"]+)"/g))nodes.set(id,element());},
            querySelector(selector){return nodes.get(selector.slice(1))||null;},setAttribute(k,v){attributes.set(k,v);},getAttribute(k){return attributes.get(k);},
            addEventListener(){},appendChild(child){this.children.push(child);if(child.id)nodes.set(child.id,child);},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}};
    }
    const document={createElement:element,getElementById(id){return nodes.get(id)||null;},body:element(),dispatchEvent(){}};
    const window={};window.top=window;window.self=window;
    vm.runInNewContext(source,{window,document,chrome:{runtime:{sendMessage(m){sent.push(m);return Promise.resolve();}}},CustomEvent:class {},Date:{now:()=>now},setInterval(fn){tick=fn;return 1;}});
    const overlay=window.GDriveVideoOverlay;
    overlay.show(true,'current-job',100,50,'720p');
    return {overlay,nodes,sent,advance(ms){now+=ms;tick();}};
}
test('processing cannot start until the current job reports verified source files',()=>{
    const {overlay}=harness();
    overlay.update({jobId:'current-job',stage:'merge',progress:0.5});
    assert.equal(overlay.getStage(),'download');
    overlay.update({jobId:'current-job',stage:'verified'});
    overlay.update({jobId:'current-job',stage:'merge',progress:0.5});
    assert.equal(overlay.getStage(),'merge');
});
test('stale job messages cannot take over the overlay or revive a cleared job',()=>{
    const {overlay}=harness();
    overlay.update({jobId:'old-job',stage:'verified'});
    overlay.update({jobId:'old-job',stage:'merge',progress:0.5});
    assert.equal(overlay.getStage(),'download');
    overlay.clearJob();
    overlay.update({jobId:'current-job',stage:'verified'});
    overlay.update({jobId:'current-job',stage:'processing'});
    assert.equal(overlay.getStage(),'download');
});
test('unknown totals stay unknown and byte counts alone never display complete',()=>{
    const {overlay,nodes}=harness();
    overlay.update({jobId:'current-job',label:'audio',received:1178,total:0,complete:false});
    assert.equal(nodes.get('psd-video-percent-audio').textContent,'…');
    overlay.update({jobId:'current-job',label:'audio',received:1178,total:1178,complete:false});
    assert.equal(nodes.get('psd-video-percent-audio').textContent,'99%');
    overlay.update({jobId:'current-job',label:'audio',received:1178,total:1178,complete:true});
    assert.equal(nodes.get('psd-video-percent-audio').textContent,'100%');
});
test('the UI does not cancel an active merger after twenty seconds',()=>{
    const {overlay,sent,advance}=harness();
    overlay.update({jobId:'current-job',stage:'verified'});
    overlay.update({jobId:'current-job',stage:'merge',progress:0.5});
    advance(21000);
    assert.equal(overlay.getJobId(),'current-job');
    assert.equal(overlay.getStage(),'merge');
    assert.equal(sent.length,0);
});
test('Chrome accepting a save is not reported as a finished download',()=>{
    const {overlay,nodes}=harness();
    overlay.update({stage:'verified'});overlay.update({stage:'started'});
    assert.equal(nodes.get('psd-video-progress-title').textContent,'Saving video');
    overlay.update({stage:'ready'});
    assert.equal(nodes.get('psd-video-progress-title').textContent,'Video downloaded');
});
