const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'bookmarklet/drive-document.js'), 'utf8').replace(/\r\n/g, '\n').trim();
const ui = fs.readFileSync(path.join(root, 'src/content/drive/ui.js'), 'utf8').replace(/\r\n/g, '\n');
const template = /const INPAGE_OVERLAY_HTML = `([\s\S]*?)`;/.exec(ui)?.[1];
const scroll = /const SCROLL_MESSAGE = `([\s\S]*?)`;/.exec(ui)?.[1];
const dimCSS = /dim\.style\.cssText = '([^']+)'/.exec(ui)?.[1];
if (!template || !scroll || !dimCSS) throw new Error('PDF extension UI template not found');

// This deliberately supports only the static markup used by the shared UI.
// Fail the build if future template changes need a different representation.
// The bookmarklet renders these trees with DOM APIs, avoiding TrustedHTML sinks.
function compileTemplate(html) {
    const tree = [];
    const stack = [{tag: null, children: tree}];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
        const parent = stack.at(-1);
        if (!token.startsWith('<')) {
            if (/&(?:#\w+|\w+);/.test(token)) throw new Error('UI text entities need explicit decoding');
            if (token.trim()) parent.children.push(token);
            continue;
        }
        const close = /^<\/([a-z][\w-]*)\s*>$/.exec(token);
        if (close) {
            if (stack.length === 1 || parent.tag !== close[1]) throw new Error('Unbalanced UI markup');
            stack.pop();
            continue;
        }
        const open = /^<(style|div|button|svg|circle|path)\b([\s\S]*?)>$/.exec(token);
        if (!open) throw new Error('Unsupported UI markup: ' + token);
        const attributes = {};
        const rest = open[2].replace(/\s+([\w-]+)=(?:"([^"]*)"|'([^']*)')/g, (_, name, double, single) => {
            if (/^on/i.test(name) || /&(?:#\w+|\w+);/.test(double ?? single)) throw new Error('Unsupported UI attribute');
            attributes[name] = double ?? single;
            return '';
        });
        if (rest.trim()) throw new Error('Unsupported UI attributes: ' + rest);
        const node = [open[1], attributes, []];
        parent.children.push(node);
        stack.push({tag: open[1], children: node[2]});
    }
    if (stack.length !== 1) throw new Error('Unclosed UI markup');
    return tree;
}
const code = '(' + source + ')(' + [compileTemplate(template), compileTemplate(scroll), dimCSS].map(JSON.stringify).join(',') + ');';
new vm.Script(code);
const filename = path.join(root, 'index.html');
const html = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
if (!/id="bm" href="javascript:[^"]+"/.test(html)) throw new Error('Bookmarklet link not found');
const generated = html.replace(/id="bm" href="javascript:[^"]+"/, 'id="bm" href="javascript:' + encodeURIComponent(code) + '"');
if (process.argv.includes('--check')) {
    if (generated !== html) throw new Error('Bookmarklet is out of date. Run npm run build:bookmarklet.');
    console.log('Bookmarklet source and shared PDF UI are in sync.');
} else {
    fs.writeFileSync(filename, generated);
    console.log('Built the document-only bookmarklet using the extension PDF UI.');
}
