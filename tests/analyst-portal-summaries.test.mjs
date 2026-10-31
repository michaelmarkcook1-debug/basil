import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meetingSummaries } from '../lib/integrations/analyst-portal.ts';

const token = 'isolated-test-credential-not-a-real-secret';
const record = { id:'fixture', kind:'context', content:'[Zoom meeting — Isolated test] 2026-10-01. Summary fixture only.',
  createdAt:'2026-10-01T12:00:00Z', updatedAt:'2026-10-02T12:00:00Z', expiresAt:'2026-10-08T12:00:00Z', privateTranscript:'excluded' };
const request = (auth = 'Bearer '+token, query = '') => new Request('https://example.test/api/summary'+query,{headers:{authorization:auth}});
const deps = (extra = {}) => ({ token, account:'fixture@example.test', resolveAccount:async identity => {
  assert.equal(identity,'fixture@example.test');return {username:'Fixture-Account'};
}, read:async username => { assert.equal(username,'fixture-account');return [record]; }, now:()=>Date.parse('2026-10-31T12:00:00Z'), ...extra });

test('missing, wrong, cookie-only credentials and alternate account query cannot read',async()=>{
  let reads=0;const read=async()=>{reads++;return []};
  assert.equal((await meetingSummaries(request(),deps({token:undefined,read}))).status,503);
  assert.equal((await meetingSummaries(request(''),deps({read}))).status,401);
  assert.equal((await meetingSummaries(request('Bearer wrong'),deps({read}))).status,401);
  assert.equal((await meetingSummaries(request('Bearer '+token,'?account=other'),deps({read}))).status,400);
  assert.equal(reads,0);
});
test('disabled account is denied before summary storage',async()=>{
  const r=await meetingSummaries(request(),deps({resolveAccount:async()=>({username:'fixture',disabled:true}),read:async()=>assert.fail('read disabled account')}));
  assert.equal(r.status,403);
});
test('response selects summaries, excludes other memory and preserves uncertainty',async()=>{
  const r=await meetingSummaries(request(),deps({read:async()=>[record,{...record,id:'person',kind:'person'},
    {...record,id:'email',content:'Private email context'}, {...record,id:'metadata',content:'[Zoom meeting — Fixture] 2026-10-01. Duration: 5 min. Attendees: fixture.'}]}));
  const body=await r.json();assert.equal(body.summaries.length,1);assert.equal(body.account,'fixture-account');
  assert.equal(body.summaries[0].summary,record.content);assert.equal(body.summaries[0].confidence,null);
  assert.equal(body.summaries[0].needsReview,true);assert.equal(body.summaries[0].expired,true);
  assert.equal(r.headers.get('cache-control'),'private, no-store');assert.ok(!JSON.stringify(body).includes('privateTranscript'));
});
test('storage errors and wrong shape are unavailable, not empty successful data',async()=>{
  for (const read of [async()=>{throw new Error('private storage failure')},async()=>({bad:'schema'})]) {
    const r=await meetingSummaries(request(),deps({read}));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private storage failure'));
  }
  const missing=await meetingSummaries(request(),deps({read:async()=>null}));assert.deepEqual((await missing.json()).summaries,[]);
});
test('bounded list reports omitted older summaries',async()=>{
  const r=await meetingSummaries(request(),deps({read:async()=>Array.from({length:51},(_,i)=>({...record,id:'fixture-'+i}))}));
  const body=await r.json();assert.equal(body.summaries.length,50);assert.equal(body.hasMore,true);
});
