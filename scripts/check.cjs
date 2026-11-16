const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(file) : [file];
    });
}
const scripts = walk(path.join(root, 'src')).filter(file => file.endsWith('.js'));
for (const file of scripts) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const referenced = [manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(script => script.js),
    ...manifest.web_accessible_resources.flatMap(resource => resource.resources)];
const worker = fs.readFileSync(path.join(root, manifest.background.service_worker), 'utf8');
referenced.push(...[...worker.matchAll(/'([^']+\.js)'/g)].map(match => 'src/' + match[1]));
const offscreen = fs.readFileSync(path.join(root, 'src/offscreen/video-offscreen.html'), 'utf8');
referenced.push(...[...offscreen.matchAll(/src="([^"]+)"/g)].map(match => 'src/offscreen/' + match[1]));
for (const file of new Set(referenced)) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing extension resource: ${file}`);
}
console.log(`Checked ${scripts.length} source scripts and ${new Set(referenced).size} extension resources.`);
