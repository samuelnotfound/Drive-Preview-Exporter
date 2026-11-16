const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = decodeURIComponent(/id="bm" href="javascript:([^"]+)"/.exec(html)[1]);

function harness(options = {}) {
    const saved = [], alerts = [], captured = [], encoders = [];
    const state = {failUI: false, failImage: false, deferImage: false, ...options};
    let now = 0, serial = 0, htmlAssignments = 0;
    function find(parent, selector) {
        for (const child of parent.children) {
            if (selector === '#' + child.id) return child;
            const match = find(child, selector);
            if (match) return match;
        }
        return null;
    }
    function node(tag) {
        const element = {
            tagName: tag.toUpperCase(), style: {}, children: [], classList: [],
            isConnected: true, textContent: '', attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; if (name === 'id') this.id = value; },
            appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
            remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); },
            scrollIntoView() {},
            querySelector(selector) { return find(this, selector); },
            querySelectorAll() { return []; },
            attachShadow() { if (state.failUI) throw new Error('UI failed'); this.shadowRoot = node('shadow'); return this.shadowRoot; }
        };
        element.classList.contains = name => element.classList.includes(name);
        element.classList.add = name => { if (!element.classList.includes(name)) element.classList.push(name); };
        // Drive enforces Trusted Types in the bookmarklet's main world.
        Object.defineProperty(element, 'innerHTML', {set() { htmlAssignments++; throw new TypeError('This document requires TrustedHTML assignment'); }});
        if (tag === 'canvas') {
            element.getContext = () => ({fillRect() {}, drawImage(img) { captured.push(img.pageIndex); }});
            element.toBlob = callback => {
                const complete = () => callback(state.failImage ? null : new Blob([new Uint8Array([255, 216, 255, 217])], {type: 'image/jpeg'}));
                if (state.deferImage) encoders.push(complete); else complete();
            };
        }
        if (tag === 'a') element.click = function () { saved.push({blob: blobURLs.get(this.href), name: this.download}); };
        return element;
    }
    const container = node('div');
    const pages = [0, 1].map(index => {
        const page = node('div');
        page.classList.push('page');
        page.parentElement = container;
        const image = node('img');
        Object.assign(image, {naturalWidth: 800, naturalHeight: 1000, complete: true, currentSrc: 'blob:page-' + index, src: 'blob:page-' + index, pageIndex: index, parentElement: page});
        page.querySelectorAll = () => [image];
        page.image = image;
        return page;
    });
    container.children = pages;
    const document = {
        title: state.title ?? 'file.pdf - Google Drive',
        querySelector(selector) { return selector === 'meta[itemprop="name"]' && state.metaName ? {content: state.metaName} : null; },
        querySelectorAll(selector) { return selector === 'img, canvas' ? pages.map(page => page.image) : []; },
        getElementById(id) { return find(this.documentElement, '#' + id); },
        createElement: node,
        createElementNS(namespace, tag) { const element = node(tag); element.namespaceURI = namespace; return element; },
        createTextNode(text) { const element = node('#text'); element.textContent = text; return element; }
    };
    document.documentElement = node('html');
    document.body = node('body');
    const blobURLs = new Map();
    const window = {__dpeRunning: !!state.staleLock};
    const url = {createObjectURL(blob) { const id = 'blob:test-' + (++serial); blobURLs.set(id, blob); return id; }, revokeObjectURL(id) { blobURLs.delete(id); }};
    const context = vm.createContext({window, document, location: {hostname: 'drive.google.com', pathname: '/file/d/test/view'}, alert: message => alerts.push(message), setTimeout(fn, ms) { if (ms < 4000) { now += ms; queueMicrotask(fn); } }, Date: {now: () => now}, Blob, Uint8Array, TextEncoder, URL: url});
    function run() { vm.runInContext(code, context); }
    run();
    async function settle() { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); }
    return {saved, alerts, captured, window, state, encoders, document, run, settle, get htmlAssignments() { return htmlAssignments; }};
}

test('full page-to-PDF capture works under Trusted Types with the shared HTML and SVG UI', async () => {
    const h = harness();
    await h.settle();
    assert.equal(h.htmlAssignments, 0);
    assert.deepEqual(h.alerts, []);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].name, 'file.pdf');
    assert.deepEqual(h.captured, [0, 1]);
    const pdf = await h.saved[0].blob.text();
    assert.ok(pdf.startsWith('%PDF-1.4'));
    assert.ok(pdf.includes('/Count 2'));
    const shadow = h.document.getElementById('dpe-bookmarklet-overlay').shadowRoot;
    assert.equal(shadow.querySelector('#psd-inpage-ring').namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(shadow.querySelector('#psd-inpage-overlay').classList.contains('completed'), true);
    assert.equal(h.window.__dpeRunning, false);
});

test('a stale running flag without a card does not silently block capture', async () => {
    const h = harness({staleLock: true});
    await h.settle();
    assert.equal(h.saved.length, 1);
});

test('capture errors release the lock and another click can retry without refreshing', async () => {
    const h = harness({failImage: true});
    await h.settle();
    assert.equal(h.saved.length, 0);
    assert.equal(h.window.__dpeRunning, false);
    const shadow = h.document.getElementById('dpe-bookmarklet-overlay').shadowRoot;
    assert.equal(shadow.querySelector('#psd-inpage-overlay').classList.contains('error'), true);
    h.state.failImage = false;
    h.run();
    await h.settle();
    assert.equal(h.saved.length, 1);
});

test('UI initialization errors are visible, release the lock, and allow retry', async () => {
    const h = harness({failUI: true});
    await h.settle();
    assert.equal(h.window.__dpeRunning, false);
    assert.equal(h.document.getElementById('dpe-bookmarklet-overlay'), null);
    assert.match(h.alerts[0], /Could not start document download: UI failed/);
    h.state.failUI = false;
    h.run();
    await h.settle();
    assert.equal(h.saved.length, 1);
});

test('the PDF name can come from metadata when the tab title is generic', async () => {
    const h = harness({title: 'Preview - Google Drive', metaName: 'notes.pdf'});
    await h.settle();
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].name, 'notes.pdf');
});

test('rendered document pages remain detectable when filename metadata is absent', async () => {
    const h = harness({title: 'Preview - Google Drive'});
    await h.settle();
    assert.equal(h.saved.length, 1);
});

test('repeat clicks during an active capture do not create duplicate downloads', async () => {
    const h = harness({deferImage: true});
    await h.settle();
    h.run();
    assert.equal(h.encoders.length, 1);
    h.state.deferImage = false;
    h.encoders.shift()();
    await h.settle();
    assert.equal(h.saved.length, 1);
});

test('a cancelled capture cannot save or release a newer capture lock', async () => {
    const h = harness({deferImage: true});
    await h.settle();
    const oldShadow = h.document.getElementById('dpe-bookmarklet-overlay').shadowRoot;
    oldShadow.querySelector('#psd-inpage-toggle').onclick();
    assert.equal(h.window.__dpeRunning, false);
    h.run();
    await h.settle();
    const newToken = h.window.__dpeRunToken;
    assert.equal(h.window.__dpeRunning, true);
    h.encoders.shift()();
    await h.settle();
    assert.equal(h.saved.length, 0);
    assert.equal(h.window.__dpeRunToken, newToken);
    assert.equal(h.window.__dpeRunning, true);
    h.state.deferImage = false;
    h.encoders.shift()();
    await h.settle();
    assert.equal(h.saved.length, 1);
    assert.equal(h.window.__dpeRunning, false);
});

test('a completed card does not block another capture', async () => {
    const h = harness();
    await h.settle();
    h.run();
    await h.settle();
    assert.equal(h.saved.length, 2);
});
