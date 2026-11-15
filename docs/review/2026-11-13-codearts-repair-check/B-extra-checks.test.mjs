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
test('B2 close/reopen discards pending confirm and prepare responses',async()=>{
 const gate=deferred();
 const s=setup((url)=>url==='/companion/prepare'?preview:url.endsWith('/confirm')?gate.promise:{code:0,data:{hasMemory:false}});
 await draft(s);
 const p=s.findButton('确认保存为私密日记').onclick();
 s.ui.closePanel();await s.action('memory');await flush();
 gate.resolve({code:0,data:{diaryId:1,date:'2026-11-13',url:'diary-write.html?date=2026-11-13',isPublic:false}});await p;
 assert.doesNotMatch(s.nodes['cc-panel-body'].textContent,/日记编号|已保存为/);
 assert.match(s.nodes['cc-panel-body'].textContent,/还没有聊天/);
});
test('B3 confirm busy disables cancel/back/edit and prevents cancel API',async()=>{
 const gate=deferred();let deletes=0;
 const s=setup((url,opt)=>url==='/companion/prepare'?preview:url.endsWith('/confirm')?gate.promise:opt.method==='DELETE'?(deletes++,{code:0}):{code:0,data:{}});
 await draft(s);const cancel=s.findButton('取消草稿'),back=s.findButton('返回修改选择');
 const p=s.findButton('确认保存为私密日记').onclick();
 assert.equal(cancel.disabled,true);assert.equal(back.disabled,true);
 await cancel.onclick();assert.equal(deletes,0);
 gate.resolve({code:0,data:{diaryId:1,date:'2026-11-13',url:'diary-write.html?date=2026-11-13',isPublic:false}});await p;
});
test('B1 two missing confirm responses can recover later using same id',async()=>{
 let posts=0;
 const s=setup((url,opt)=>{
  if(url==='/companion/prepare')return preview;
  if(url.endsWith('/confirm'))return ++posts<=2?{code:-1}:{code:0,data:{diaryId:123,date:'2026-11-13',url:'diary-write.html?date=2026-11-13',isPublic:false}};
  return {code:0,data:{draft:{id:'draft',status:'confirmed'}}};
 });
 await draft(s);await s.findButton('确认保存为私密日记').onclick();
 assert.match(s.nodes['cc-panel-body'].textContent,/服务端已确认/);
 assert.equal(s.findButton('确认保存为私密日记').disabled,false);
 await s.findButton('确认保存为私密日记').onclick();
 assert.match(s.nodes['cc-panel-body'].textContent,/日记编号：123/);
 assert.equal(s.calls.filter(c=>c.url==='/companion/prepare').length,1);
});
test('B4 REMAINING: crisis result leaves enabled generation button and repeats prepare',async()=>{
 let prepares=0;
 const s=setup(url=>{if(url==='/companion/prepare'){prepares++;return {code:0,data:{draft:null,care:{message:'support',lines:[{name:'help',phone:'12356'}]}}};}return {code:0,data:{}};});
 await s.action('draft');s.ui.state.turns=[{role:'user',content:'synthetic crisis'}];s.ui.renderDraftSelection();
 s.nodes['cc-panel-body'].querySelectorAll=()=>[{value:'0'}];
 const prepare=s.findButton('生成草稿');await prepare.onclick();
 assert.match(s.nodes['cc-panel-body'].textContent,/已停止生成/);
 assert.equal(prepare.disabled,false);
 await prepare.onclick();assert.equal(prepares,2);
});

