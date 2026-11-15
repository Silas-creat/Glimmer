const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '../../../前端参考') + '/';
class El {
 constructor(tag='div') {this.tag=tag;this.children=[];this.events={};this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.attrs={};}
 set textContent(v){this.text=String(v);this.children=[];}
 get textContent(){return (this.text||'')+this.children.map(x=>x.textContent).join('');}
 appendChild(x){this.children.push(x);x.parent=this;return x;}
 replaceChildren(...xs){this.text='';this.children=xs;for(const x of xs)x.parent=this;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
 focus(){}
 setAttribute(k,v){this.attrs[k]=v;}
 getAttribute(k){return this.attrs[k];}
 addEventListener(k,v){(this.events[k]??=[]).push(v);}
 closest(){return this;}
 querySelectorAll(){return [];}
 emit(k,event={}){return Promise.all((this.events[k]||[]).map(fn=>fn(event)));}
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function setup(request, saved=false){
 const ids=['chat','input','send','model-status','care','cc-mode-note','cc-save-toggle','cc-save-state','cc-save-hint','cc-tools','cc-panel','cc-panel-title','cc-panel-body','cc-panel-close'];
 const nodes=Object.fromEntries(ids.map(x=>[x,new El()]));
 const storage=new Map(saved?[['wg_ai_save_mode_A','on']]:[]);
 let user={uid:'A'},token='token-A';
 const ctx=vm.createContext({console,document:{createElement:t=>new El(t),getElementById:id=>nodes[id],activeElement:null,addEventListener(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},getToken:()=>token,getUser:()=>user,setUser:u=>{user=u;}});
 for(const file of ['chat-session.js','chat-companion.js'])vm.runInContext(fs.readFileSync(root+file,'utf8'),ctx,{filename:file});
 const api=async(p,o)=>p==='/ai/status'?{code:0,data:{isReal:false}}:request(p,o);
 const ui=ctx.ChatCompanion.mountChatCompanion({api});
 const action=async name=>{const target=new El();target.setAttribute('data-cc-action',name);await nodes['cc-tools'].emit('click',{target});};
 const buttons=()=>{const all=[];function visit(n){if(n.tag==='button')all.push(n);n.children.forEach(visit);}visit(nodes['cc-panel-body']);return all;};
 return {ctx,nodes,ui,storage,action,buttons,setAccount:(u,t)=>{user=u;token=t;}};
}
(async()=>{
 // A1: explicit opt-out loses to the earlier opt-in verification response.
 const verify=deferred();
 const s=setup(async p=>p==='/auth/me'?verify.promise:{code:0,data:{list:[],hasMore:false}});
 s.nodes['cc-save-toggle'].checked=true;const enabling=s.nodes['cc-save-toggle'].emit('change');
 s.nodes['cc-save-toggle'].checked=false;await s.nodes['cc-save-toggle'].emit('change');
 assert.equal(s.ui.state.mode,'temporary');
 verify.resolve({code:0,data:{user:{uid:'A'}}});await enabling;
 assert.equal(s.ui.state.mode,'saved');assert.equal(s.storage.get('wg_ai_save_mode_A'),'on');
 console.log('A1 REPRO: user toggled OFF during auth, late response re-enabled SAVED and persisted on.');

 // A2: clearing during an in-flight temporary send invalidates UI, not helper writes.
 const reply=deferred(), bodies=[];
 const t=setup(async(p,o)=>{
  if(p==='/ai/chat'){bodies.push(o.body);return bodies.length===1?reply.promise:{code:0,data:{reply:{content:'new reply'},saved:false,provider:{isReal:false}}};}
  if(p==='/ai/memory'&&o.method==='DELETE')return {code:0,data:{deleted:0}};
  throw Error('unexpected '+p);
 });
 t.nodes.input.value='private message before clear';const sending=t.nodes.send.emit('click');
 await t.action('clear');await t.buttons().find(x=>x.textContent==='确认清除').onclick();
 assert.equal(t.ui.state.turns.length,0);
 reply.resolve({code:0,data:{reply:{content:'private old reply'},saved:false,provider:{isReal:false}}});await sending;
 t.nodes.input.value='new conversation after clear';await t.nodes.send.emit('click');
 assert.equal(bodies[1].history[0].content,'private message before clear');
 console.log('A2 REPRO: next temporary request includes 2 cleared messages after old response settles.');

 // A3: another-tab login replaces storage token; existing saved page keeps A mode.
 let account='A';const posts=[];
 const a=setup(async(p,o)=>{
  if(p==='/auth/me')return {code:0,data:{user:{uid:account}}};
  if(p.startsWith('/ai/messages'))return {code:0,data:{list:[],hasMore:false}};
  if(p==='/ai/chat'){posts.push({account,body:o.body});return {code:0,data:{reply:{content:'ok'},saved:true,provider:{isReal:false}}};}
  throw Error('unexpected '+p);
 },true);await flush();assert.equal(a.ui.state.mode,'saved');
 account='B';a.setAccount({uid:'B'},'token-B');
 a.nodes.input.value='sent after another tab logs in B';await a.nodes.send.emit('click');
 assert.equal(posts[0].account,'B');assert.equal(posts[0].body.remember,true);assert.equal(a.storage.has('wg_ai_save_mode_B'),false);assert.equal(a.ui.state.uid,'A');
 console.log('A3 REPRO: B has no save consent, but existing A page sends remember:true using B token.');

 // A4: a stale memory panel request can repopulate summary after successful clear.
 const memory=deferred();
 const m=setup(async(p,o)=>p==='/ai/memory'&&o.method==='DELETE'?{code:0,data:{deleted:2}}:memory.promise);
 await m.action('memory');await m.action('clear');await m.buttons().find(x=>x.textContent==='确认清除').onclick();
 assert.match(m.nodes['cc-panel-body'].textContent,/已清除 2/);
 memory.resolve({code:0,data:{hasMemory:true,summary:'cleared sensitive summary',totalMessages:2,pendingMessages:0}});await flush();
 assert.match(m.nodes['cc-panel-body'].textContent,/cleared sensitive summary/);
 console.log('A4 REPRO: old memory GET overwrites successful clear panel with the cleared summary.');
})().catch(e=>{console.error(e);process.exitCode=1;});
