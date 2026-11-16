const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'bookmarklet/drive-document.js'),'utf8').replace(/\r\n/g,'\n').trim();
const ui=fs.readFileSync(path.join(root,'src/content/drive/ui.js'),'utf8').replace(/\r\n/g,'\n');
const template=/const INPAGE_OVERLAY_HTML = `([\s\S]*?)`;/.exec(ui)?.[1];
if(!template)throw new Error('PDF extension overlay template not found');
const code='('+source+')('+JSON.stringify(template)+');';new vm.Script(code);
const filename=path.join(root,'index.html');const html=fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n');
const generated=html.replace(/id="bm" href="javascript:[^"]+"/,'id="bm" href="javascript:'+encodeURIComponent(code)+'"');
if(generated===html&&!/id="bm" href="javascript:/.test(html))throw new Error('Bookmarklet link not found');
if(process.argv.includes('--check')){if(generated!==html)throw new Error('Bookmarklet is out of date. Run npm run build:bookmarklet.');console.log('Bookmarklet source and shared PDF UI are in sync.');}
else{fs.writeFileSync(filename,generated);console.log('Built the document-only bookmarklet using the extension PDF UI.');}
