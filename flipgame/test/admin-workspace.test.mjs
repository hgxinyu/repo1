import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const users = [{ accountId:'11111111-1111-4111-8111-111111111111', gameName:'测试玩家 Test Player', primaryEmailMasked:'t***@example.com', guild:'测试公会', role:'svip', status:'active', authzVersion:2 }, {accountId:adminId,gameName:'Admin 管理员示例长名称 Long Account Name',role:'admin',status:'active'}];
const prices = JSON.parse(await readFile(resolve(root,'quality_prices.json'),'utf8'));
async function fixture(browser, { delay = 60, failTraffic = false, failUsers = false, anonymous = false, failWrite = false } = {}) {
  const page=await browser.newPage(); const calls=[]; const errors=[]; const writes=[]; let currentUsers=structuredClone(users);
  page.on('pageerror', e=>errors.push(e.message));
  await page.context().addCookies([{name:'__Host-shinegame_csrf',value:'fixture',url:'https://admin.test',secure:true}]);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://admin.test')return route.abort();
    if(url.pathname.startsWith('/api/')) {
      calls.push(url.pathname+url.search);
      await new Promise(r=>setTimeout(r,delay));
      if(url.pathname==='/api/me' && anonymous)return route.fulfill({json:{authenticated:false}});
      if(route.request().method()==='POST') {
        writes.push({path:url.pathname,body:route.request().postDataJSON()});
        if(failWrite)return route.fulfill({status:503,json:{error:'Write fixture unavailable'}});
        if(url.pathname==='/api/admin/set-role') { const {accountId,role}=route.request().postDataJSON(); currentUsers=currentUsers.map(user=>user.accountId===accountId?{...user,role}:user); }
        return route.fulfill({json:{prices}});
      }
      if(url.pathname==='/api/me')return route.fulfill({json:{authenticated:true,accountId:adminId,role:'admin',status:'active',capabilities:{authenticated:true,role:'admin',blocked:false,canAccessRegistered:true,canAccessPremium:true,canAccessSvip:true,isAdmin:true}}});
      if(url.pathname==='/api/admin/users')return route.fulfill(failUsers?{status:503,json:{error:'Fixture unavailable'}}:{json:{users:currentUsers}});
      if(url.pathname==='/api/admin/quality-prices')return route.fulfill({json:prices});
      if(url.pathname==='/api/admin/traffic')return route.fulfill(failTraffic?{status:503,json:{error:'Fixture unavailable'}}:{json:{days:Number(url.searchParams.get('days')),totalViews:30,countries:[{country:'US',views:20,share:2/3},{country:'CN',views:10,share:1/3}],daily:Array.from({length:30},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,'0')}`,views:(i%7)+1})),pages:[{path:'/SoulAscensionCalculator.html',views:20},{path:'/index.html',views:10}],countryCount:2}});
      return route.fulfill({json:{}});
    }
    const path=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(root+'/'))return route.abort();
    try {return route.fulfill({body:await readFile(path),contentType:({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  return {page,calls,errors,writes};
}

test('admin loads only the selected workspace and reuses it while preserving price edits', async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,calls,errors}=await fixture(browser);
  await page.goto('https://admin.test/Admin.html');
  await page.locator('#userRows .account-cell').first().waitFor();
  assert.deepEqual(calls,['/api/me','/api/admin/users']);
  await page.locator('[data-workspace="prices"]').click();
  await page.locator('#priceRows input').first().waitFor();
  await page.locator('#priceRows input').first().fill('12345');
  await page.locator('[data-workspace="users"]').click();
  await page.locator('[data-workspace="prices"]').click();
  assert.equal(await page.locator('#priceRows input').first().inputValue(),'12345');
  assert.equal(calls.filter(p=>p==='/api/admin/quality-prices').length,1);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});

test('admin isolates traffic errors and coalesces repeated workspace entry', async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,calls,errors}=await fixture(browser,{delay:200,failTraffic:true});
  await page.goto('https://admin.test/Admin.html');
  await page.locator('#userRows .account-cell').first().waitFor();
  await page.locator('[data-workspace="traffic"]').click();
  await page.locator('[data-workspace="users"]').click();
  await page.locator('[data-workspace="traffic"]').click();
  await page.waitForFunction(()=>document.querySelector('#trafficStatus').textContent.includes('失败'));
  assert.equal(calls.filter(p=>p.startsWith('/api/admin/traffic')).length,1);
  assert.doesNotMatch(await page.locator('#userStatus').textContent(),/失败/);
  await page.locator('[data-workspace="users"]').click();
  assert.equal(await page.locator('#userRows .account-cell').count(),2);
  assert.deepEqual(errors,[]);
 }finally {await browser.close();}
});

test('admin deep links defer other sections and failed auth never reads admin data',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,calls}=await fixture(browser);
  await page.goto('https://admin.test/Admin.html#prices-panel');
  await page.locator('#priceRows input').first().waitFor();
  assert.deepEqual(calls,['/api/me','/api/admin/quality-prices']);
  const denied=await fixture(browser,{anonymous:true});
  await denied.page.goto('https://admin.test/Admin.html');
  await denied.page.locator('#authLogin').waitFor();
  assert.deepEqual(denied.calls,['/api/me']);
  assert.equal(await denied.page.locator('#adminLayout').isVisible(),false);
 }finally{await browser.close();}
});

test('admin role controls preserve self protection and handle failed writes without duplicates',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,writes,errors}=await fixture(browser,{failWrite:true,delay:150});
  await page.goto('https://admin.test/Admin.html');
  await page.locator('#userRows .account-cell').first().waitFor();
  assert.equal(await page.locator('#userRows tr').last().locator('[data-role-select]').isDisabled(),true);
  await page.locator('#userRows tr').first().locator('[data-role-select]').selectOption('vip');
  await page.locator('#userRows tr').first().locator('[data-apply-role]').click();
  await page.waitForFunction(()=>document.querySelector('#userStatus').dataset.state==='error');
  assert.equal(writes.length,1);
  assert.equal(writes[0].body.role,'vip');
  assert.equal(await page.locator('#userRows tr').first().locator('[data-role-select]').inputValue(),'svip');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('admin responsive layouts keep primary actions and editable prices visible',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,errors}=await fixture(browser);
  await page.goto('https://admin.test/Admin.html');
  await page.locator('#userRows .account-cell').first().waitFor();
  for(const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:1000});
    for(const workspace of ['users','prices','traffic']) {
      await page.locator(`[data-workspace="${workspace}"]`).click();
      await page.waitForFunction(name=>document.querySelector(`#${name}-panel`).getAttribute('aria-busy')!=='true',workspace);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${workspace} ${width}`);
      assert.equal(await page.locator(`[data-workspace="${workspace}"]`).isVisible(),true);
      await page.screenshot({path:`/private/tmp/admin-redesign-${workspace}-${width}.png`,fullPage:true});
    }
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('admin applies a membership change once and saves prices with protected dirty state',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const {page,writes,errors}=await fixture(browser,{delay:120});
  await page.goto('https://admin.test/Admin.html');
  await page.locator('#userRows .account-cell').first().waitFor();
  await page.locator('#userRows tr').first().locator('[data-role-select]').selectOption('vip');
  await page.locator('#userRows tr').first().locator('[data-apply-role]').evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>document.querySelector('#userRows [data-role-select]').value==='vip'&&!document.querySelector('#userRows [data-role-select]').disabled);
  assert.equal(writes.length,1);
  await page.locator('[data-workspace="prices"]').click();
  await page.locator('#priceRows input').first().waitFor();
  assert.equal(await page.locator('#savePricesBtn').isDisabled(),true);
  await page.locator('#priceRows input').first().fill('123');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.locator('#reloadPricesBtn').click();
  assert.equal(await page.locator('#priceRows input').first().inputValue(),'123');
  await page.locator('#savePricesBtn').click();
  await page.waitForFunction(()=>document.querySelector('#priceStatus').dataset.state==='ready');
  assert.equal(writes.length,2);
  assert.equal(writes[1].body.tiers[0].foodPrice,123);
  assert.equal(await page.locator('#savePricesBtn').isDisabled(),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
