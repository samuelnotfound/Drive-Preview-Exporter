const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared/stream-url.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/background/format-catalog.js'), 'utf8'), context);

test('removes ranges at any query position while preserving signed parameters byte for byte', () => {
    const base = 'https://media.googleusercontent.com/videoplayback';
    const signed = 'sig=a%2fb%20c+z&expire=123&clen=4096';
    for (const query of [`range=0-1&${signed}`, `sig=a%2fb%20c+z&range=0-1&expire=123&clen=4096`, `${signed}&range=0-1`, `range=0-1&${signed}&RANGE=2-3`]) {
        assert.equal(context.cleanURL(`${base}?${query}#player`), `${base}?${signed}#player`);
    }
    assert.equal(context.cleanURL(`${base}?range=0-1`), base);
    assert.equal(context.cleanURL(`${base}?range&sig=abc`), `${base}?sig=abc`);
});
test('leaves unrelated parameters, fragments and missing input alone', () => {
    for (const url of ['https://example.com/?signature=range%3D0-1', 'https://example.com/?ranges=0-1#range=0-1', 'https://example.com/#?range=0-1', 'relative/path']) assert.equal(context.cleanURL(url), url);
    assert.equal(context.cleanURL(''), null);
    assert.equal(context.cleanURL(null), null);
});
test('stream catalog retains authentication and metadata after the player range', () => {
    const stream=context.parseStreamCandidate('https://example.com/video?range=0-1&sig=abc&clen=1024&itag=137');
    assert.equal(stream.url, 'https://example.com/video?sig=abc&clen=1024&itag=137');
    assert.equal(stream.contentLength,1024);
    assert.equal(stream.height,1080);
});
test('range requests preserve signed query encoding and replace old ranges', () => {
    const base='https://example.com/video?sig=a%2fb%20c+z&clen=42';
    assert.equal(context.GDriveStreamURL.withRange(base+'&range=0-1#player',2,41),base+'&range=2-41#player');
    assert.equal(context.GDriveStreamURL.withRange('https://example.com/video#player',0,1),'https://example.com/video?range=0-1#player');
});
