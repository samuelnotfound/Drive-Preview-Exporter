var mp4Remux=function(){"use strict";var Q=Object.defineProperty;var X=(m,i,b)=>i in m?Q(m,i,{enumerable:!0,configurable:!0,writable:!0,value:b}):m[i]=b;var v=(m,i,b)=>(X(m,typeof i!="symbol"?i+"":i,b),b);const m=Object.freeze(Object.defineProperty({__proto__:null,get edts(){return J},get free(){return D},get ftyp(){return F},get mdat(){return G},get mdia(){return H},get mfhd(){return P},get moof(){return y},get moov(){return C},get mvex(){return V},get mvhd(){return R},get sidx(){return O},get tfdt(){return L},get tfhd(){return A},get tkhd(){return q},get traf(){return B},get trak(){return T},get trex(){return b},get trun(){return M},get udta(){return W}},Symbol.toStringTag,{value:"Module"}));class i{constructor(t){v(this,"stream",new Uint8Array);v(this,"dv",new DataView(new Uint8Array().buffer));v(this,"boxs",[]);v(this,"boxPos",0);this.stream=t,this.dv=new DataView(t.buffer)}set size(t){this.writeUint(4,t)}get size(){return this.readUint(4)}get type(){return this.readString(4,4)}get raw(){if(this.boxPos){let t=this.boxPos;const e=this.boxs.map(u=>{const p=u.raw;return t+=p.length,p});this.size=t;const r=this.stream.slice(0,this.boxPos),s=new Uint8Array(t);let a=0;for(const u of[r,...e])s.set(u,a),a+=u.length;return s}return this.stream}writeUint(t,e,r=0){const s=this.dv;switch(t){case 1:s.setUint8(r,e);break;case 2:s.setUint16(r,e);break;case 4:s.setUint32(r,e);break}}writeInt(t,e,r=0){const s=this.dv;switch(t){case 1:s.setInt8(r,e);break;case 2:s.setInt16(r,e);break;case 4:s.setInt32(r,e);break}}readInt(t=4,e=0){const r=this.dv;switch(t){case 1:return r.getInt8(e);case 2:return r.getInt16(e);case 4:return r.getInt32(e)}}readUint(t,e=0){const r=this.dv;switch(t){case 1:return r.getUint8(e);case 2:return r.getUint16(e);case 4:return r.getUint32(e)}}readString(t,e=0){let r="";for(let s=0;s<t;s++)r+=String.fromCharCode(this.readUint(1,e+s));return r}parse(t){this.boxPos=t;let e=t;for(;e<=this.stream.length-8;){const r0=this.readUint(4,e),s=this.readString(4,4+e),r=r0||this.stream.length-e;if(r<=this.stream.length){const a=this.stream.slice(e,e+r),u=m[s]||D;this.boxs.push(new u(a))}if(!r0)break;e+=r}}}class b extends i{get version(){return this.readUint(1,8)}get track_id(){return this.readUint(4,12)}set track_id(t){this.writeUint(4,t,12)}}class M extends i{get sample_count(){return this.readUint(4,12)}get data_offset(){return this.readInt(4,16)}set data_offset(t){this.writeInt(4,t,16)}}class L extends i{}class A extends i{get version(){return this.readUint(1,8)}get track_id(){return this.readUint(4,12)}set track_id(t){this.writeUint(4,t,12)}}class B extends i{constructor(t){super(t),this.parse(8)}get tfhd(){return this.boxs.find(t=>t instanceof A)}get trun(){return this.boxs.find(t=>t instanceof M)}}class P extends i{get sequence_number(){return this.readUint(4,12)}}class W extends i{}class H extends i{}class F extends i{}class D extends i{}class C extends i{constructor(t){super(t),this.parse(8)}get mvhd(){return this.boxs.find(t=>t instanceof R)}get mvex(){return this.boxs.find(t=>t instanceof V)}get trak(){return this.boxs.find(t=>t instanceof T)}}class y extends i{constructor(t){super(t),this.parse(8)}get mfhd(){return this.boxs.find(t=>t instanceof P)}get traf(){return this.boxs.find(t=>t instanceof B)}}class O extends i{get version(){return this.readUint(1,8)}get reference_ID(){return this.readUint(4,12)}get timescale(){return this.readUint(4,16)}get reserved(){let t=28;return this.version!==0&&(t=36),this.readUint(2,t)}get reference_count(){let t=28;return this.version!==0&&(t=36),t+=2,this.readUint(2,t)}get refList(){let t=32;this.version!==0&&(t=40);const e=this.reference_count,r=[];for(let s=0;s<e;s++){const a=t+s*12;let u=this.readUint(4,a);const p=u>>31&1,S=u&2147483647,d=this.readUint(4,a+4);u=this.readUint(4,a+8);const w=u>>31&1,U=u>>28&7,z=u&268435455;r.push({reference_type:p,referenced_size:S,subsegment_duration:d,starts_with_SAP:w,SAP_type:U,SAP_delta_time:z})}return r}}class G extends i{push(t){const e=new Uint8Array(this.stream.length+t.length);e.set(this.stream),e.set(t,this.stream.length),this.stream=e,this.dv=new DataView(this.stream.buffer),this.size=e.length}}class R extends i{get version(){return this.readUint(1,8)}get next_track_ID(){return this.version===0?this.readUint(4,104):this.readUint(4,116)}set next_track_ID(t){this.version===0?this.writeUint(4,t,104):this.writeUint(4,t,116)}}class V extends i{constructor(t){super(t),this.parse(8)}get trex(){return this.boxs.find(t=>t instanceof b)}}class q extends i{get version(){return this.readUint(1,8)}get track_id(){return this.version===1?this.readUint(4,28):this.readUint(4,20)}set track_id(t){this.version===1?this.writeUint(4,t,28):this.writeUint(4,t,20)}}class T extends i{constructor(t){super(t),this.parse(8)}get tkhd(){return this.boxs.find(t=>t instanceof q)}}class J extends i{}class j{constructor(){v(this,"stream",new Uint8Array);v(this,"dv",new DataView(new Uint8Array().buffer));v(this,"boxs",[]);v(this,"isEnd",!1)}get sidx(){return this.boxs.find(t=>t instanceof O)}get moov(){return this.boxs.find(t=>t instanceof C)}push(t){const e=new Uint8Array(this.stream.length+t.length);e.set(this.stream),e.set(t,this.stream.length),this.stream=e,this.dv=new DataView(this.stream.buffer)}slice(t){const e=this.stream.slice(0,t),r=new Uint8Array(this.stream.length-t);return r.set(this.stream.slice(t)),this.stream=r,this.dv=new DataView(this.stream.buffer),e}readUint(t,e=0){const r=this.dv;switch(t){case 1:return r.getUint8(e);case 2:return r.getUint16(e);case 4:return r.getUint32(e)}}readString(t,e=0){let r="";for(let s=0;s<t;s++)r+=String.fromCharCode(this.readUint(1,e+s));return r}parse(){if(this.stream.length<8)return;const t=this.readUint(4),e=this.readString(4,4);if(t===0){if(!this.isEnd)return;const r=this.slice(this.stream.length),s=m[e]||D;this.boxs.push(new s(r));return}if(t<=this.stream.length){const r=this.slice(t),s=m[e]||D;this.boxs.push(new s(r)),this.parse()}}end(){this.isEnd=!0}}function K(video, audio) {
  const videoReader = video.getReader(), audioReader = audio.getReader();
  const videoBoxes = new j(), audioBoxes = new j();
  const { readable, writable } = new TransformStream();
  const output = writable.getWriter();
  let sequence = -1;
  let processing = Promise.resolve();

  // Each write waits for the disk sink. Without this, the original library
  // buffered every MP4 fragment in the TransformStream, exhausting RAM.
  async function write(box) { await output.write(box); }

  async function mergeAvailable() {
    if (sequence === -2) return;
    if (sequence === -1) {
      const videoMovie = videoBoxes.moov, audioMovie = audioBoxes.moov;
      if (videoMovie && audioMovie) {
        const videoExtras = videoMovie.mvex, audioExtras = audioMovie.mvex;
        if (videoExtras && audioExtras) {
          const videoTrack = videoExtras.trex, audioTrack = audioExtras.trex;
          if (videoTrack) videoTrack.track_id = 1;
          if (audioTrack) audioTrack.track_id = 2;
          videoExtras.boxs = videoExtras.boxs.filter(box => !(box instanceof b));
          if (videoTrack) videoExtras.boxs.push(videoTrack);
          if (audioTrack) videoExtras.boxs.push(audioTrack);
        }
        const videoTrack = videoMovie.trak, audioTrack = audioMovie.trak;
        if (videoTrack && audioTrack) {
          videoTrack.tkhd.track_id = 1;
          audioTrack.tkhd.track_id = 2;
          videoMovie.boxs.push(audioTrack);
          for (const box of videoBoxes.boxs) {
            await write(box.raw);
            if (box === videoMovie) break;
          }
          sequence = 1;
        }
      }
    }
    if (!videoBoxes.sidx || !audioBoxes.sidx || sequence < 0) return;
    const videoCount = videoBoxes.sidx.reference_count;
    const audioCount = audioBoxes.sidx.reference_count;
    while (sequence > 0) {
      if (sequence > videoCount && sequence > audioCount) {
        sequence = -2;
        await output.close();
        return;
      }
      const findPair = (boxes) => {
        const fragment = boxes.boxs.find(box => box instanceof y && box.mfhd?.sequence_number === sequence);
        if (!fragment) return null;
        const media = boxes.boxs[boxes.boxs.indexOf(fragment) + 1];
        return media ? { fragment, media } : null;
      };
      const videoPair = sequence <= videoCount ? findPair(videoBoxes) : null;
      const audioPair = sequence <= audioCount ? findPair(audioBoxes) : null;
      if ((sequence <= videoCount && !videoPair) || (sequence <= audioCount && !audioPair)) return;

      if (videoPair && audioPair) {
        const v = videoPair.fragment, a = audioPair.fragment;
        v.traf.tfhd.track_id = 1;
        a.traf.tfhd.track_id = 2;
        if (v.traf.trun && a.traf.trun) {
          const videoFragmentSize = v.size, audioFragmentSize = a.traf.size;
          v.traf.trun.data_offset = videoFragmentSize + audioFragmentSize + 8;
          a.traf.trun.data_offset = videoFragmentSize + audioFragmentSize + videoPair.media.size;
          v.boxs.push(a.traf);
          await write(v.raw);
          videoPair.media.push(audioPair.media.raw.slice(8));
          await write(videoPair.media.raw);
        }
      } else {
        const pair = videoPair || audioPair;
        pair.fragment.traf.tfhd.track_id = videoPair ? 1 : 2;
        await write(pair.fragment.raw);
        await write(pair.media.raw);
      }
      for (const [boxes, pair] of [[videoBoxes, videoPair], [audioBoxes, audioPair]]) {
        if (pair) boxes.boxs = boxes.boxs.filter(box => box !== pair.fragment && box !== pair.media);
      }
      sequence++;
    }
  }

  // Serialize updates from the two input streams to avoid output reordering.
  function flush() {
    const next = processing.then(mergeAvailable);
    processing = next.catch(() => {});
    return next;
  }

  async function consume(reader, boxes) {
    try {
      for (;;) {
        // Do not let one track buffer an entire multi-GB file while waiting
        // for the other track's matching fragment.
        while (boxes.boxs.length > 12 && sequence !== -2) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const { done, value } = await reader.read();
        if (value?.length) {
          boxes.push(value);
          boxes.parse();
          // Reject an unusually huge unfragmented MP4 box before it can
          // exhaust memory. Drive's fragmented MP4 streams have small boxes.
          if (boxes.stream.length > 128 * 1024 * 1024) {
            throw new Error('An MP4 fragment is too large for safe streaming.');
          }
          await flush();
        }
        if (done) { boxes.end(); await flush(); break; }
      }
    } catch (error) {
      try { await output.abort(error); } catch (_) {}
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  void consume(videoReader, videoBoxes);
  void consume(audioReader, audioBoxes);
  return readable;
}
return K}();
//# sourceMappingURL=mp4-remux.iife.js.map
