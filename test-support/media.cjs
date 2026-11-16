function box(type, ...parts) {
    const payload=Buffer.concat(parts);
    const header=Buffer.alloc(8);
    header.writeUInt32BE(8+payload.length);
    header.write(type,4,'ascii');
    return Buffer.concat([header,payload]);
}
function mp4({kind='video',duration=10,payload=Buffer.from('media samples'),payloadBytes,headerOnly=false}={}) {
    if (payloadBytes) {payload=Buffer.alloc(payloadBytes);for(let i=0;i<payload.length;i++)payload[i]=i%251;}
    const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(duration*1000,16);
    const hdlr=Buffer.alloc(20);hdlr.write(kind==='audio'?'soun':'vide',8,'ascii');
    const metadata=box('moov',box('trak',box('mdia',box('mdhd',mdhd),box('hdlr',hdlr))));
    return Buffer.concat([box('ftyp',Buffer.from('isom\x00\x00\x00\x00isomiso2')),metadata,...(headerOnly?[]:[box('mdat',payload)])]);
}
module.exports={mp4,box};
