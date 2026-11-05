'use strict';

// The chat page (raw media/chat.js under node:vm) after the audit fixes. H1-H3 (audit V6): no channel keeps more than
// JetBrains' 500 messages, in the saved view state or on screen. H4-H5 (audit V7): a selection restored with the view
// state, or one that lived through a disconnect, is selected again by the next channel list, which reloads its messages
// and enables the input. H6-H7 (audit V10): message text cannot leave the attribute it is written into, and a decision
// card is found by its data, not by a selector built from its id. The element stand-in is wire-parity.test.cjs's (tests
// share no helper module), with parents, so remove() works, and with a browser's textContent-to-innerHTML escaping.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const PAGE_PATH = path.join(__dirname, '../media/chat.js');
const PAGE_JS = fs.readFileSync(PAGE_PATH, 'utf8');
const jsonCopy = value => JSON.parse(JSON.stringify(value));

const CHAN_G = { id: 'chan-g', name: 'general', type: 'general' };
const CHAN_X = { id: 'chan-x', name: 'x', type: 'custom' };
const AT = '2026-11-05T10:00:00.000Z';
const message = (channel, id, content = `hello ${id}`) => ({ id, channel, sender: 'worker-1', content, timestamp: AT });
const messages = (channel, count) => Array.from({ length: count }, (_, i) => message(channel, `m${i}`));

/** One generic DOM element. Assigning innerHTML or textContent replaces every child, as in the DOM. */
function makeElement() {
    let html = '';
    const el = {
        dataset: {}, style: {}, className: '', value: '', disabled: false, children: [], listeners: {}, parent: null,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        remove() { if (el.parent) { el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; } },
        querySelector: () => null,
        // Children carrying the class (the page only asks for classes, of its direct children).
        querySelectorAll: selector => el.children.filter(child => child.className.split(' ').includes(selector.slice(1))),
        scrollTo() {}, focus() {}
    };
    Object.defineProperty(el, 'innerHTML', {
        get: () => html,
        set: value => { html = String(value); el.children.length = 0; }
    });
    // A browser escapes only &, < and > when it serialises text: quotes come back as they went in.
    Object.defineProperty(el, 'textContent', {
        get: () => html,
        set: value => { html = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); el.children.length = 0; }
    });
    return el;
}

/** Run the unmodified page script, its view state restored from `saved`, and hand back what the test may observe. */
function loadPage(saved) {
    const elements = new Map();
    const byId = id => {
        if (!elements.has(id)) { elements.set(id, makeElement()); }
        return elements.get(id);
    };
    byId('chatInput').disabled = true; // as the provider's markup has them
    byId('sendBtn').disabled = true;
    const stateWrites = [], posts = [];
    let onMessage;
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        acquireVsCodeApi: () => ({
            getState: () => saved,
            setState: state => { stateWrites.push(jsonCopy(state)); },
            postMessage: posted => { posts.push(jsonCopy(posted)); }
        }),
        document: { getElementById: byId, createElement: () => makeElement() },
        window: { addEventListener: (type, handler) => { if (type === 'message') { onMessage = handler; } } }
    });
    vm.runInContext(PAGE_JS, context, { filename: PAGE_PATH });
    assert.equal(typeof onMessage, 'function', 'media/chat.js registered no message handler');
    return {
        byId, posts, stateWrites,
        send: data => onMessage({ data }),
        updateChannels: channels => onMessage({ data: { type: 'updateChannels', channels } }),
        selectPosts: () => posts.filter(p => p.type === 'selectChannel').map(p => p.channel),
        savedCache: channel => stateWrites.at(-1).messageCache[channel],
        shownIds: () => byId('messages').children.map(child => child.dataset.id)
    };
}

const ids = list => list.map(m => m.id);
const range = (from, to) => Array.from({ length: to - from }, (_, i) => `m${from + i}`);

test('H1 a restored cache longer than 500 messages is cut to the newest 500 before it is saved again (audit V6)', () => {
    const page = loadPage({ currentChannel: 'chan-g', messageCache: { 'chan-g': messages('chan-g', 600) } });
    page.send({ type: 'newMessage', message: message('chan-x', 'x1') }); // saves the view state
    assert.deepEqual(ids(page.savedCache('chan-g')), range(100, 600));
});

test('H2 a channel loaded with 600 messages keeps and shows the newest 500 (audit V6)', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G]);
    page.send({ type: 'loadMessages', channel: 'chan-g', messages: messages('chan-g', 600) });
    assert.deepEqual(ids(page.savedCache('chan-g')), range(100, 600));
    assert.deepEqual(page.shownIds(), range(100, 600));
});

test('H3 new messages on a full channel drop its oldest, in the saved state and on screen (audit V6)', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G, CHAN_X]);
    page.send({ type: 'loadMessages', channel: 'chan-g', messages: messages('chan-g', 500) });
    page.send({ type: 'newMessage', message: message('chan-g', 'm500') });
    page.send({ type: 'newMessage', message: message('chan-g', 'm501') });
    assert.deepEqual(ids(page.savedCache('chan-g')), range(2, 502));
    assert.deepEqual(page.shownIds(), range(2, 502));
    for (let i = 0; i < 501; i++) { page.send({ type: 'newMessage', message: message('chan-x', `x${i}`) }); } // a channel not on screen
    assert.equal(page.savedCache('chan-x').length, 500);
    assert.equal(page.savedCache('chan-x')[0].id, 'x1');
});

test('H4 a selection restored with the view state is selected again by the first channel list (audit V7)', () => {
    const page = loadPage({ currentChannel: 'chan-x', messageCache: { 'chan-x': [message('chan-x', 'old')] } });
    page.updateChannels([CHAN_G, CHAN_X]);
    assert.deepEqual(page.selectPosts(), ['chan-x'], 'its messages are asked for again');
    assert.deepEqual([page.byId('chatInput').disabled, page.byId('sendBtn').disabled], [false, false]);
    page.updateChannels([CHAN_G, CHAN_X]);
    assert.deepEqual(page.selectPosts(), ['chan-x'], 'a later list leaves it alone');
});

test('H5 after a disconnect the next channel list reloads the selection; without one it is left alone (audit V7)', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G]);
    page.updateChannels([CHAN_G]);
    assert.deepEqual(page.selectPosts(), ['chan-g'], 'connected throughout: selected once');
    page.send({ type: 'updateConnection', status: 'disconnected' });
    page.send({ type: 'updateConnection', status: 'connected' });
    page.updateChannels([CHAN_G]);
    assert.deepEqual(page.selectPosts(), ['chan-g', 'chan-g']);
    page.updateChannels([CHAN_G]);
    assert.deepEqual(page.selectPosts(), ['chan-g', 'chan-g']);
});

test('H6 a quote in a link or a message id stays inside its attribute (audit V10)', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G]);
    page.send({ type: 'loadMessages', channel: 'chan-g', messages: [message('chan-g', 'm"1', '[docs](https://evil.example" style="color:red)')] });
    const html = page.byId('messages').children[0].innerHTML;
    assert.ok(html.includes('<a href="https://evil.example&quot; style=&quot;color:red" target="_blank">docs</a>'), html);
    assert.ok(html.includes('data-msg-id="m&quot;1"'), html);
    assert.ok(!html.includes('style="color:red"'), 'no attribute of its own');
});

test('H7 a resolved decision updates the card that carries its id, quotes and all (audit V10)', () => {
    const page = loadPage();
    page.updateChannels([CHAN_G]);
    const card = makeElement();
    card.className = 'decision-card';
    card.dataset.decisionId = 'dec-"1'; // as the browser decodes data-decision-id="dec-&quot;1"
    page.byId('messages').appendChild(card);
    page.send({ type: 'decisionResolved', decision: { id: 'dec-"1', status: 'approved', approvedBy: 'human', content: 'ship it' } });
    assert.deepEqual(card.children.map(child => [child.className, child.innerHTML]), [['decision-status approved', '&#10003; Approved by human']]);
});
