// Real MySQL + ephemeral HTTP. Only synthetic accounts are created and removed.
import assert from 'node:assert/strict';
import express from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import { pool, query, queryOne, insert } from '../src/db/index.js';
import { signToken } from '../src/utils/jwt.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import interact from '../src/routes/interact.js';
import logs from '../src/routes/logs.js';
import comment from '../src/routes/comment.js';
import bless from '../src/routes/bless.js';
import { DIARY_SELECT, serializeDiary } from '../src/utils/diaryHelper.js';

const users = [];
let server;
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  const suffix = randomUUID().slice(0, 6);
  for (let i=0; i<3; i++) {
    const phone = '19' + randomInt(100000000, 999999999);
    const nick = `social${suffix}${i}`;
    const id = await insert('INSERT INTO users (phone, uid, nickname) VALUES (?, ?, ?)', [phone, randomUUID().replaceAll('-', '').slice(0,16), nick]);
    users.push({id, nick, token:signToken({id,phone})});
  }
  const [a,b,c] = users;
  const app=express(); app.use(express.json());
  app.use('/api/interact',interact); app.use('/api',logs); app.use('/api/comment',comment); app.use('/api/bless',bless);
  app.use(notFound); app.use(errorHandler);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=async(method,path,body,user=a)=>{
    const headers={'Content-Type':'application/json'}; if(user)headers.Authorization=`Bearer ${user.token}`;
    const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,...await r.json()};
  };
  const report=(type,id,user=a)=>request('POST','/report',{targetType:type,targetId:id,reason:'synthetic review'},user);
  const diary=await insert('INSERT INTO diaries (user_id,date_key,text,is_public) VALUES (?,?,?,1)',[b.id,'2026-11-12','synthetic public diary']);
  const privateDiary=await insert('INSERT INTO diaries (user_id,date_key,text,is_public) VALUES (?,?,?,0)',[b.id,'2026-11-13','synthetic private secret']);
  const privateComment=await insert('INSERT INTO comments (diary_id,user_id,content) VALUES (?,?,?)',[privateDiary,b.id,'private comment secret']);
  const publicComment=await insert('INSERT INTO comments (diary_id,user_id,content) VALUES (?,?,?)',[diary,b.id,'public comment']);

  await check('new social endpoints require authentication',async()=>{
    assert.equal((await request('GET','/interact/friend-stats',undefined,null)).status,401);
    assert.equal((await request('GET','/report/mine',undefined,null)).status,401);
  });
  await check('mutual-only totals and fan fields match actual relations',async()=>{
    await query('INSERT INTO follows (user_id,target_id) VALUES (?,?),(?,?),(?,?)',[a.id,b.id,b.id,a.id,a.id,c.id]);
    const r=await request('GET','/interact/my-follows?mutual=1&size=1');
    assert.equal(r.data.total,1); assert.equal(r.data.list.length,1); assert.equal(r.data.hasMore,false);
    assert.equal(r.data.list[0].userId,b.id); assert.equal(r.data.list[0].isMutual,true);
    assert.deepEqual((await request('GET','/interact/friend-stats')).data,{friends:1,fans:1,following:2});
    const fans=(await request('GET','/interact/my-fans')).data;
    assert.equal(fans.total,1); assert.equal(fans.list[0].isFollowedBack,true); assert.equal(fans.list[0].diaryCount,1);
  });
  await check('favorite count comes from real favorite rows',async()=>{
    await query('INSERT INTO favorites (user_id,diary_id) VALUES (?,?),(?,?)',[a.id,diary,c.id,diary]);
    assert.equal(serializeDiary(await queryOne(`${DIARY_SELECT} WHERE d.id=?`,[diary])).saves,2);
  });
  await check('private diary and comment cannot be reported to reveal content',async()=>{
    assert.equal((await report('diary',privateDiary)).status,404);
    assert.equal((await report('comment',privateComment)).status,404);
    assert.equal((await report('user',999999999)).status,404);
  });
  await check('report details are visible only while the target remains visible',async()=>{
    assert.equal((await report('diary',diary)).status,200);
    assert.equal((await report('comment',publicComment)).status,200);
    assert.equal((await report('diary',diary)).status,409);
    let list=(await request('GET','/report/mine')).data.list;
    assert.ok(list.filter(x=>['diary','comment'].includes(x.targetType)).every(x=>x.targetInfo));
    await query('UPDATE diaries SET is_public=0 WHERE id=?',[diary]);
    list=(await request('GET','/report/mine')).data.list;
    assert.ok(list.filter(x=>['diary','comment'].includes(x.targetType)).every(x=>x.targetInfo===null));
    await query('UPDATE diaries SET is_public=1 WHERE id=?',[diary]);
  });

  const {sendDirectMessage}=await import('../src/utils/dm.js');
  const pair=async(x,y)=>queryOne('SELECT * FROM conversations WHERE user_a=? AND user_b=?',[Math.min(x,y),Math.max(x,y)]);
  async function withFailedUnreadUpdate(fn) {
    const original=pool.getConnection;
    pool.getConnection=async function(){
      const conn=await original.call(this);
      return new Proxy(conn,{get(target,key){
        if(key==='execute')return async(sql,args)=>{
          if(sql.startsWith('UPDATE conversations SET last_msg'))throw new Error('synthetic DM transaction interruption');
          return target.execute(sql,args);
        };
        const value=target[key];return typeof value==='function'?value.bind(target):value;
      }});
    };
    try{return await fn();}finally{pool.getConnection=original;}
  }
  await check('automated DMs preserve sender unread and increment recipient atomically',async()=>{
    await sendDirectMessage(b.id,a.id,'synthetic incoming');
    let conv=await pair(a.id,b.id); const sideA=Number(conv.user_a)===a.id?'a':'b',sideB=sideA==='a'?'b':'a';
    assert.equal(conv[`unread_${sideA}`],1);
    await Promise.all(Array.from({length:3},(_,i)=>sendDirectMessage(a.id,b.id,`synthetic notice ${i}`)));
    conv=await pair(a.id,b.id);
    assert.equal(conv[`unread_${sideA}`],1); assert.equal(conv[`unread_${sideB}`],3);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?',[conv.id])).n),4);
  });
  await check('automated DMs respect blocks and private source visibility',async()=>{
    const conv=await pair(a.id,b.id);
    await query('UPDATE conversations SET blocked_by=? WHERE id=?',[b.id,conv.id]);
    assert.equal(await sendDirectMessage(a.id,b.id,'blocked notice'),null);
    await query('UPDATE conversations SET blocked_by=NULL WHERE id=?',[conv.id]);
    assert.equal(await sendDirectMessage(b.id,a.id,'private source notice',{diaryId:privateDiary}),null);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?',[conv.id])).n),4);
  });
  await check('failure between message insert and unread update rolls back the transaction',async()=>{
    const before=await pair(a.id,b.id);
    await withFailedUnreadUpdate(async()=>{
      await assert.rejects(sendDirectMessage(a.id,b.id,'must roll back'),/synthetic DM transaction interruption/);
      await assert.rejects(sendDirectMessage(b.id,c.id,'new conversation must roll back'),/synthetic DM transaction interruption/);
    });
    assert.deepEqual(await pair(a.id,b.id),before);
    assert.equal(await pair(b.id,c.id),null);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?',[before.id])).n),4);
  });
  await check('friend greeting requires mutual follows and preserves existing unread',async()=>{
    await sendDirectMessage(c.id,b.id,'synthetic unread before friendship');
    let conv=await pair(b.id,c.id);
    const side=Number(conv.user_a)===b.id?'a':'b';
    assert.equal(conv[`unread_${side}`],1);
    assert.equal((await request('POST',`/interact/follow/${c.id}`,{},b)).status,200);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND is_sys=1',[conv.id])).n),0);
    assert.equal((await request('POST',`/interact/follow/${b.id}`,{},c)).status,200);
    conv=await pair(b.id,c.id);
    assert.equal(conv[`unread_${side}`],1);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND is_sys=1',[conv.id])).n),1);
  });
  await check('message reports accept only received normal non-system messages',async()=>{
    const conv=await pair(a.id,b.id);
    const own=await insert('INSERT INTO messages (conv_id,from_user,to_user,content) VALUES (?,?,?,?)',[conv.id,a.id,b.id,'own']);
    const received=await insert('INSERT INTO messages (conv_id,from_user,to_user,content) VALUES (?,?,?,?)',[conv.id,b.id,a.id,'received']);
    const blocked=await insert("INSERT INTO messages (conv_id,from_user,to_user,content,status) VALUES (?,?,?,?,'blocked')",[conv.id,b.id,a.id,'hidden blocked']);
    const sys=await insert('INSERT INTO messages (conv_id,from_user,to_user,content,is_sys) VALUES (?,?,?,?,1)',[conv.id,b.id,a.id,'system']);
    assert.equal((await report('message',own)).status,400);
    assert.equal((await report('message',received)).status,200);
    assert.equal((await report('message',received,c)).status,404);
    assert.equal((await report('message',blocked)).status,404);
    assert.equal((await report('message',sys)).status,404);
    await query("INSERT INTO reports (user_id,target_type,target_id,reason) VALUES (?,'message',?,'historic invalid')",[c.id,received]);
    assert.equal((await request('GET','/report/mine',undefined,c)).data.list[0].targetInfo,null);
    await query("UPDATE messages SET status='blocked' WHERE id=?",[received]);
    assert.equal((await request('GET','/report/mine')).data.list.find(r=>r.targetType==='message'&&Number(r.targetId)===received).targetInfo,null);
  });
  await check('mentions use a DM with a diary link and no duplicate mention notification',async()=>{
    const result=await request('POST','/comment',{diaryId:diary,content:`@${b.nick} 今天很平静`});
    assert.equal(result.status,200);
    const conv=await pair(a.id,b.id);
    const message=await queryOne('SELECT content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1',[conv.id]);
    assert.match(message.content,new RegExp(`\\[跳转\\] diary-public.html\\?id=${diary}$`));
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE from_user_id=? AND to_user_id=? AND comment_id=?",[a.id,b.id,result.data.comment.id])).n),0);
    const privateResult=await request('POST','/comment',{diaryId:privateDiary,content:`@${a.nick} 私密记录`},b);
    assert.equal(privateResult.status,200);
    assert.equal((await queryOne('SELECT content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1',[conv.id])).content,message.content);
  });
  await check('blessings produce a DM link without duplicate interaction notification',async()=>{
    const result=await request('POST','/bless/send',{toUserId:c.id,content:'愿你今天有个好心情'});
    assert.equal(result.status,200);
    const conv=await pair(a.id,c.id);
    assert.match((await queryOne('SELECT content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1',[conv.id])).content,/\[跳转\] bless-sent.html\?type=received$/);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE from_user_id=? AND to_user_id=? AND type='bless'",[a.id,c.id])).n),0);
  });
  await check('a failed optional DM does not discard saved comments or blessings',async()=>{
    const before=await pair(a.id,b.id);
    const count=Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?',[before.id])).n);
    await withFailedUnreadUpdate(async()=>{
      const posted=await request('POST','/comment',{diaryId:diary,content:`@${b.nick} 一起慢慢走`});
      assert.equal(posted.status,200);
      assert.ok(await queryOne('SELECT id FROM comments WHERE id=? AND user_id=?',[posted.data.comment.id,a.id]));
      const blessed=await request('POST','/bless/send',{toUserId:b.id,content:'希望你今晚好好休息'});
      assert.equal(blessed.status,200);
      assert.ok(await queryOne('SELECT id FROM blessings WHERE from_user=? AND to_user=?',[a.id,b.id]));
    });
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?',[before.id])).n),count);
    assert.deepEqual(await pair(a.id,b.id),before);
  });
  console.log(`MERGE24 SOCIAL: ${passed} groups passed.`);
}catch(error){console.error(error.stack);process.exitCode=1;}
finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  for(const u of users)await query('DELETE FROM users WHERE id=? AND nickname=?',[u.id,u.nick]);
  await pool.end();
}
