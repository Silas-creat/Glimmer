// Real MySQL + ephemeral HTTP with one disposable user and private test room.
import assert from 'node:assert/strict';
import express from 'express';
import {randomInt,randomUUID} from 'node:crypto';
import {pool,query,queryOne,insert} from '../src/db/index.js';
import {signToken} from '../src/utils/jwt.js';
import {errorHandler} from '../src/middleware/error.js';
import group from '../src/routes/group.js';
import {resetViolations} from '../src/utils/chatBot.js';
const suffix=randomUUID().slice(0,8), nick='mutetest'+suffix, code='mutetest'+suffix;
let userId,roomId,server;
try {
  const phone='19'+randomInt(100000000,999999999);
  userId=await insert('INSERT INTO users(phone,uid,nickname) VALUES(?,?,?)',[phone,randomUUID().replaceAll('-','').slice(0,16),nick]);
  roomId=await insert("INSERT INTO chat_rooms(code,name,kind) VALUES(?,?,'custom')",[code,'Synthetic mute regression']);
  await query('INSERT INTO chat_members(room_id,user_id) VALUES(?,?)',[roomId,userId]);
  const app=express(); app.use(express.json()); app.use('/api/group',group); app.use(errorHandler);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const token=signToken({id:userId,phone});
  const send=async content=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/group/rooms/${code}/messages`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({content})});
    return {status:r.status,...await r.json()};
  };
  const currentMute=()=>queryOne('SELECT UNIX_TIMESTAMP(muted_until) AS deadline, UNIX_TIMESTAMP(NOW(3)) AS now FROM chat_members WHERE room_id=? AND user_id=?',[roomId,userId]);
  const mixed='想消失，扫码转账领奖';
  for(const [name,expression] of [['existing long mute','DATE_ADD(NOW(3), INTERVAL 300 SECOND)'],['no prior mute','NULL'],['expired mute','DATE_SUB(NOW(3), INTERVAL 30 SECOND)']]) {
    resetViolations();
    await query(`UPDATE chat_members SET muted_until=${expression} WHERE room_id=? AND user_id=?`,[roomId,userId]);
    const before=await currentMute();
    for(let i=0;i<2;i++) {
      const response=await send(mixed);
      assert.equal(response.status,200); assert.equal(response.data.blocked,true); assert.ok(response.data.care);
    }
    const after=await currentMute();
    assert.ok(Number(after.deadline)>=Number(before.deadline),`${name}: new penalty shortened existing mute`);
    assert.ok(Number(after.deadline)>Number(after.now)+20,`${name}: new penalty missing`);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM chat_messages WHERE room_id=? AND content=?',[roomId,mixed])).n),0);
    assert.equal((await send('普通消息')).status,429);
    const help=await send('撑不下去了');
    assert.equal(help.status,200); assert.equal(help.data.blocked,false); assert.ok(help.data.care);
    assert.ok(Number((await currentMute()).deadline)>=Number(after.deadline));
    console.log('PASS '+name+' preserves deadline and permits crisis support');
  }
  console.log('MERGE24 MUTE: 3 groups passed.');
} catch(error) { console.error(error.stack); process.exitCode=1; }
finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(roomId)await query('DELETE FROM chat_rooms WHERE id=? AND code=?',[roomId,code]);
  if(userId)await query('DELETE FROM users WHERE id=? AND nickname=?',[userId,nick]);
  await pool.end();
}
