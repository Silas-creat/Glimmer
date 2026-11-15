const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, '后端源码/scripts/test-chat-companion-repair.test.js'), 'utf8');
const harness = source.slice(source.indexOf('class El {'), source.indexOf('const chatSuccess ='));
const {setup, deferred, flush, El} = new Function('fs','vm','ROOT',harness+'\nreturn {setup,deferred,flush,El};')(fs,vm,path.join(root,'前端参考')+path.sep);
const preview = {code:0,data:{draft:{id:'synthetic-draft',date:'2026-11-13',text:'synthetic',status:'pending',sources:[]}}};
async function run() {
  const verification = deferred();
  let s;
  const posts=[];
  s=setup((url,opts)=>{
    if(url==='/auth/me') return verification.promise;
    if(url==='/companion/prepare') { posts.push({body:opts.body,account:s.ctx.getUser().uid,tokenIsB:s.ctx.getToken()==='token-B'});return preview; }
    return {code:0,data:{}};
  });
  s.ui.state.turns=[{role:'user',content:'A synthetic private material'}];
  await s.action('draft');
  s.nodes['cc-panel-body'].querySelectorAll=()=>[{value:'0'}];
  s.setAccount({uid:'A'},'token-A-refreshed');
  const pending = s.findButton('生成草稿').onclick();
  await flush();
  assert.equal(s.calls.filter(c=>c.url==='/auth/me').length,1);
  s.setAccount({uid:'B'},'token-B');
  s.emitStorage('wg_user');
  assert.equal(s.ui.state.uid,'B');
  verification.resolve({code:0,data:{user:{uid:'A'}}});
  await pending;
  assert.equal(posts.length,1);
  assert.equal(posts[0].account,'B');
  assert.equal(posts[0].tokenIsB,true);
  assert.equal(posts[0].body.message,'A synthetic private material');
  console.log('REPRO: delayed identity verification for A submits A material with current B credentials after storage reset.');

  const guest=setup((url)=>({code:0,data:{reply:{content:'guest reply'},saved:false,provider:{isReal:false}}}),{user:{},token:''});
  guest.setAccount(null,'');
  guest.nodes.input.value='synthetic anonymous temporary message';
  await guest.nodes.send.emit('click');
  assert.equal(guest.calls.filter(c=>c.url==='/ai/chat').length,0);
  assert.match(guest.nodes['cc-save-state'].textContent,/登录状态暂时无法确认/);
  console.log('REPRO: anonymous temporary chat is blocked before /ai/chat although it previously allowed temporary messages.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
