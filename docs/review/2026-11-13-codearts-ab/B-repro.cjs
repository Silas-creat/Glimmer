// Read-only isolated reproductions against actual functions in chat-companion.js.
// No database, network, or production-file writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const src = fs.readFileSync(path.resolve(__dirname, '../../../前端参考/chat-companion.js'), 'utf8');
function extract(name, next) {
  const start = src.search(new RegExp('(?:async )?function ' + name + '\\('));
  const end = src.search(new RegExp('(?:async )?function ' + next + '\\('));
  assert.ok(start >= 0 && end > start, name);
  return src.slice(start, end).trim();
}
const source = [
  extract('buildDraftMaterial', 'draftTextIssue'),
  extract('draftTextIssue', 'mergeHistoryPages'),
  extract('mapDraftError', 'isSafeDiaryUrl'),
  extract('prepareDraft', 'renderDraftPreview'),
  extract('confirmDraft', 'resolveUnknownDraft'),
  extract('resolveUnknownDraft', 'cancelDraft'),
  extract('cancelDraft', 'sendMessage'),
].join('\n');
function context(request) {
  const ctx = {
    MAX_MESSAGE: 2000, MAX_DRAFT_TEXT: 5000,
    state: {draft: {id:'draft-1', date:'2026-11-13', text:'合成测试正文', status:'pending'}},
    request, encodeURIComponent, isValidDateKey: () => true,
    selectedTurns: () => ['合成测试材料'],
    appendCare: () => {}, responseCare: () => null, showCare: () => {},
    element: () => ({appendChild() {}}), button: () => ({}),
    panelBodyEl: {appendChild() {}},
    renderDraftSelection: () => {},
    rendered: [],
  };
  ctx.renderDraftPreview = () => ctx.rendered.push(ctx.state.draft.id);
  ctx.renderConfirmSuccess = data => ctx.rendered.push(data);
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}
function deferred() {
  let resolve;
  const promise = new Promise(r => {resolve = r;});
  return {promise, resolve};
}

(async () => {
  // A successful server write whose POST response was lost.
  const calls = [];
  const recovery = context(async (url, opts) => {
    calls.push({url, method:opts.method || 'GET'});
    if (opts.method === 'POST') return {code:-1};
    return {code:0, data:{draft:{id:'draft-1', date:'2026-11-13', status:'confirmed'}}};
  });
  await recovery.confirmDraft({disabled:false}, {}, {value:'合成测试正文'});
  assert.equal(recovery.rendered[0].diaryId, null);
  assert.equal(recovery.rendered[0].url, null);
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);
  console.log('REPRODUCED recovery: confirmed is rendered with diaryId=null and url=null; no idempotent POST retry.');

  // Two prepares can overlap after closing/reopening the sheet.
  const first = deferred(), second = deferred();
  let count = 0;
  const stale = context(() => (++count === 1 ? first.promise : second.promise));
  const firstRequest = stale.prepareDraft({}, {value:'2026-11-12'}, {checked:false}, {});
  const secondRequest = stale.prepareDraft({}, {value:'2026-11-13'}, {checked:false}, {});
  second.resolve({code:0, data:{draft:{id:'newer-draft', date:'2026-11-13'}}});
  await secondRequest;
  first.resolve({code:0, data:{draft:{id:'older-draft', date:'2026-11-12'}}});
  await firstRequest;
  assert.deepEqual(stale.rendered, ['newer-draft', 'older-draft']);
  assert.equal(stale.state.draft.id, 'older-draft');
  console.log('REPRODUCED prepare race: late first request replaces newer draft/preview.');

  // A normal cancel leaves confirmation enabled and draft status unchanged.
  const cancelCalls = [];
  const cancelled = context(async (url, opts) => {
    cancelCalls.push({url, method:opts.method});
    return opts.method === 'DELETE'
      ? {code:0, data:{draft:{id:'draft-1', status:'cancelled'}}}
      : {code:40900, msg:'草稿已取消'};
  });
  const cancelButton = {disabled:false}, confirmButton = {disabled:false}, status = {};
  await cancelled.cancelDraft(cancelButton, status);
  assert.equal(cancelled.state.draft.status, 'pending');
  assert.equal(confirmButton.disabled, false);
  await cancelled.confirmDraft(confirmButton, status, {value:'合成测试正文'});
  assert.match(status.textContent, /这一天已有日记/);
  assert.equal(cancelCalls.length, 2);
  console.log('REPRODUCED cancelled state: confirm still submits; cancellation error shown as same-date diary conflict.');
})().catch(error => { console.error(error); process.exitCode = 1; });
