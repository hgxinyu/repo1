import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeAuthState} from '../../assets/auth-session.js';

// Exercise the actual page gate with the shared client's normalized response,
// rather than a Local Admin preview or an invented flat isAdmin response.
const page=readFileSync(new URL('../../GuideAdmin.html',import.meta.url),'utf8');
const condition=page.match(/const me=await getAuthMe\(\);if\((.*?)\)throw/)[1];
const isDenied=new Function('me',`return (${condition});`);
function state(role){return normalizeAuthState({authenticated:true,accountId:'11111111-1111-4111-8111-111111111111',role,status:'active',capabilities:{authenticated:true,role,blocked:false,canAccessRegistered:true,canAccessPremium:['vip','svip','admin'].includes(role),canAccessSvip:['svip','admin'].includes(role),isAdmin:role==='admin'}});}
test('guide admin admits normalized authenticated admins',()=>{
 const me=state('admin');assert.equal(me.isAdmin,undefined);assert.equal(me.capabilities.isAdmin,true);assert.equal(isDenied(me),false);
});
test('guide admin rejects anonymous, non-admin and malformed states',()=>{
 for(const role of ['free','pending','vip','svip'])assert.equal(isDenied(state(role)),true);
 assert.equal(isDenied(normalizeAuthState(null)),true);
 assert.equal(isDenied(normalizeAuthState({authenticated:true,isAdmin:true})),true);
});
