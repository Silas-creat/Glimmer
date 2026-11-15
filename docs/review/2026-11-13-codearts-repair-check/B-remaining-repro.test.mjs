import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../前端参考') + path.sep;
const require = createRequire(import.meta.url);
const companion = require('../../../前端参考/chat-companion.js');

class El {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.events = {};
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.text = '';
    this.href = '';
    this.type = '';
    this.onclick = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; children.forEach(child => { child.parent = this; }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() {}
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
  closest() { return this; }
  querySelectorAll() { return []; }
  emit(type, event = {}) { return Promise.all((this.events[type] || []).map(handler => handler(event))); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(request, options = {}) {
  const ids = [
    'chat', 'input', 'send', 'model-status', 'care', 'cc-mode-note',
    'cc-save-toggle', 'cc-save-state', 'cc-save-hint', 'cc-tools',
    'cc-panel', 'cc-panel-title', 'cc-panel-body', 'cc-panel-close',
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, new El()]));
  nodes['cc-panel'].hidden = true;

  const storage = new Map(options.saved ? [['wg_ai_save_mode_A', 'on']] : []);
  let user = options.user || { uid: 'A' };
  let token = options.token === undefined ? 'token-A' : options.token;
  const storageListeners = [];
  const calls = [];

  const ctx = vm.createContext({
    console,
    document: {
      createElement: tag => new El(tag),
      getElementById: id => nodes[id],
      activeElement: null,
      addEventListener() {},
    },
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    getToken: () => token,
    getUser: () => user,
    setUser: next => { user = next; },
    addEventListener: (type, handler) => { if (type === 'storage') storageListeners.push(handler); },
  });

  for (const file of ['chat-session.js', 'chat-companion.js']) {
    vm.runInContext(fs.readFileSync(ROOT + file, 'utf8'), ctx, { filename: file });
  }

  const api = async (url, optionsArg = {}) => {
    calls.push({ url, method: optionsArg.method || 'GET', body: optionsArg.body });
    if (url === '/ai/status') return { code: 0, data: { isReal: false } };
    return request(url, optionsArg);
  };
  const ui = ctx.ChatCompanion.mountChatCompanion({ api });

  const action = async name => {
    const target = new El();
    target.setAttribute('data-cc-action', name);
    await nodes['cc-tools'].emit('click', { target });
  };
  const buttons = () => {
    const all = [];
    const visit = node => {
      if (node.tag === 'button') all.push(node);
      node.children.forEach(visit);
    };
    visit(nodes['cc-panel-body']);
    return all;
  };
  const findButton = text => buttons().find(node => node.textContent === text);
  const setAccount = (nextUser, nextToken) => { user = nextUser; token = nextToken; };
  const emitStorage = key => storageListeners.forEach(handler => handler({ key }));

  return { ctx, nodes, ui, storage, calls, action, buttons, findButton, setAccount, emitStorage };
}

async function draft(s) {
  await s.action('draft');
  s.ui.state.turns = [{role:'user',content:'synthetic material'}];
  s.nodes['cc-panel-body'].querySelectorAll=()=>[{value:'0'}];
  await s.ui.prepareDraft(new El('button'),{value:'2026-11-13'},{checked:false},new El('p'));
}
const preview={code:0,data:{draft:{id:'draft',date:'2026-11-13',text:'text',status:'pending',sources:[]}}};
test('REPRO B care after confirming edited crisis text is outside the open dialog', async()=>{
 const care={message:'synthetic crisis support',lines:[{name:'help',phone:'12356'}]};
 const s=setup(url=>url==='/companion/prepare'?preview:url.endsWith('/confirm')?{code:0,data:{diaryId:10,date:'2026-11-13',url:'diary-write.html?date=2026-11-13',isPublic:false,care}}:{code:0,data:{}});
 await draft(s);
 await s.findButton('确认保存为私密日记').onclick();
 assert.equal(s.nodes['cc-panel'].hidden,false);
 assert.match(s.nodes.care.textContent,/synthetic crisis support/);
 assert.doesNotMatch(s.nodes['cc-panel-body'].textContent,/synthetic crisis support|12356/);
});
test('REPRO B draft prepare does not check current identity before sending old account material', async()=>{
 const s=setup(url=>url==='/companion/prepare'?preview:{code:0,data:{}});
 await s.action('draft');s.ui.state.turns=[{role:'user',content:'A private material'}];s.ui.renderDraftSelection();
 s.nodes['cc-panel-body'].querySelectorAll=()=>[{value:'0'}];
 s.setAccount({uid:'B'},'token-B');
 await s.findButton('生成草稿').onclick();
 assert.equal(s.ui.state.uid,'A');
 assert.equal(s.ctx.getToken(),'token-B');
 assert.equal(s.calls.find(c=>c.url==='/companion/prepare').body.message,'A private material');
});
test('REPRO B crisis prepare still allows repeated generation in stopped flow', async()=>{
 let posts=0;
 const s=setup(url=>url==='/companion/prepare'?(posts++,{code:0,data:{draft:null,care:{message:'support',lines:[{name:'help',phone:'12356'}]}}}):{code:0,data:{}});
 await s.action('draft');s.ui.state.turns=[{role:'user',content:'synthetic crisis'}];s.ui.renderDraftSelection();
 s.nodes['cc-panel-body'].querySelectorAll=()=>[{value:'0'}];
 const button=s.findButton('生成草稿');await button.onclick();
 assert.equal(button.disabled,false);await button.onclick();
 assert.equal(posts,2);assert.match(s.nodes['cc-panel-body'].textContent,/已停止生成/);
});
