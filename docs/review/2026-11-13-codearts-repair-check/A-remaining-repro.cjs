const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const testSource = fs.readFileSync(path.join(root, '后端源码/scripts/test-chat-companion-repair.test.js'), 'utf8');
// Reuse the submitted minimal DOM harness, while adding independent orderings.
const start = testSource.indexOf('class El {');
const end = testSource.indexOf('const chatSuccess =');
const { setup, deferred, flush } = new Function('fs', 'vm', 'ROOT', testSource.slice(start, end) + '\nreturn {setup,deferred,flush};')(fs, vm, path.join(root, '前端参考') + path.sep);
const chatOk = text => ({ code:0, data:{ reply:{content:text}, saved:false, provider:{isReal:false} } });

(async () => {
  // R-A1: A's pending delete must not wipe B's later chat or claim it cleared B.
  const deletion = deferred();
  const a = setup((url, opts) => {
    if(url === '/ai/memory' && opts.method === 'DELETE') return deletion.promise;
    if(url === '/ai/chat') return chatOk('B fresh reply');
    return {code:0,data:{}};
  });
  await a.action('clear');
  const deleting = a.findButton('确认清除').onclick();
  a.setAccount({uid:'B'}, 'token-B'); a.emitStorage('wg_user');
  a.nodes.input.value = 'B new conversation'; await a.nodes.send.emit('click');
  assert.match(a.nodes.chat.textContent, /B new conversation/);
  assert.equal(a.ui.state.uid,'B');
  deletion.resolve({code:0,data:{deleted:2}}); await deleting;
  assert.equal(a.ui.state.uid,'B');
  assert.equal(a.ui.state.turns.length,0);
  assert.doesNotMatch(a.nodes.chat.textContent,/B new conversation/);
  assert.match(a.nodes['cc-save-state'].textContent,/已清除本人/);
  console.log('REPRO A-remaining-1: delayed clear for A wipes B chat/context and falsely announces B cleared.');

  // R-A2: memory opened while clear is pending can arrive after clear succeeds.
  const clear = deferred(), memory = deferred();
  const b = setup((url, opts) => {
    if(url === '/ai/memory' && opts.method === 'DELETE') return clear.promise;
    if(url === '/ai/memory') return memory.promise;
    return {code:0,data:{}};
  });
  await b.action('clear');
  const clearPending = b.findButton('确认清除').onclick();
  b.ui.closePanel(); await b.action('memory');
  clear.resolve({code:0,data:{deleted:2}}); await clearPending;
  assert.match(b.nodes['cc-save-state'].textContent,/已清除/);
  memory.resolve({code:0,data:{hasMemory:true,summary:'snapshot obtained before delete',totalMessages:2}}); await flush();
  assert.match(b.nodes['cc-panel-body'].textContent,/snapshot obtained before delete/);
  assert.equal(b.ui.state.memorySnapshot.summary,'snapshot obtained before delete');
  console.log('REPRO A-remaining-2: memory started during pending clear returns after success and restores cleared summary.');

  // R-A3: settling an obsolete send must not unlock the next send's pending UI.
  const old = deferred(), newer = deferred(); let n=0;
  const c=setup((url,opts)=>{
    if(url==='/ai/chat')return ++n===1?old.promise:newer.promise;
    if(url==='/ai/memory'&&opts.method==='DELETE')return {code:0,data:{deleted:0}};
    return {code:0,data:{}};
  });
  c.nodes.input.value='old';const oldSending=c.nodes.send.emit('click');await flush();
  await c.action('clear');await c.findButton('确认清除').onclick();
  c.nodes.input.value='new pending';const newSending=c.nodes.send.emit('click');await flush();
  assert.equal(c.ui.state.sending,true);
  old.resolve(chatOk('old reply'));await oldSending;
  assert.equal(c.ui.state.sending,false);assert.equal(c.nodes.send.disabled,false);
  c.nodes.input.value='third message';await c.nodes.send.emit('click');
  assert.equal(n,2);assert.match(c.nodes.chat.textContent,/third message/);assert.match(c.nodes.chat.textContent,/正在回复，请稍等一下/);
  newer.resolve(chatOk('new reply'));await newSending;
  console.log('REPRO A-remaining-3: obsolete send finally unlocks pending new request; a third message renders without being sent.');
})().catch(err=>{console.error(err);process.exitCode=1;});
