import express from 'express';
import { auth } from '../middleware/auth.js';
import { ok, wrap, ApiError } from '../utils/response.js';
import { prepareDraft, getDraft, confirmDraft, cancelDraft } from '../utils/companion.js';

const router = express.Router();
router.use(auth);

function body(req) {
  const value = req.body ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError('请求内容必须是对象', 400);
  return value;
}

router.post('/prepare', wrap(async (req, res) => ok(res, await prepareDraft(req.uid, body(req)))));
router.get('/drafts/:id', wrap(async (req, res) => ok(res, { draft: await getDraft(req.uid, req.params.id) })));
router.post('/drafts/:id/confirm', wrap(async (req, res) => ok(res, await confirmDraft(req.uid, req.params.id, body(req)), '私密日记已保存')));
router.delete('/drafts/:id', wrap(async (req, res) => ok(res, { draft: await cancelDraft(req.uid, req.params.id) })));

export default router;
