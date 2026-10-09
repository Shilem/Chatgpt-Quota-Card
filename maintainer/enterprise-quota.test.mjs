import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource, patchSource } from '../bin/patch-codex-quota-card.mjs';

const plans = ['business', 'enterprise', 'enterprise_cbp_usage_based', 'edu', 'hc'];
const policyModule = 'function policy(p){return p!=null&&managed.includes(p)}var managed;function init(){managed=[`business`,`enterprise`,`enterprise_cbp_usage_based`,`edu`,`hc`]}export{policy as enterprisePolicy};';
const context = { sourcePath: 'assets/card.js', moduleSources: new Map([['assets/plans.js', { text: policyModule }]]) };
const source = 'import{v as monthly}from"./crseajay.js";import{enterprisePolicy as managedPlan}from"./plans.js";function card(p){void`codex-quota-card-patch:v7`;let{data:r}=dataHook(atom),d=r===void 0?null:r,b=entries(d).find(x=>x.limitName==null),w=buckets({entry:b,keyPrefix:`sidebar-quota-card`});return(0,j.jsx)(`div`,{className:merge(`w-full`,p.className)})' + ' '.repeat(5000) + '}function gate(p){let{authMethod:a}=auth();return(0,j.jsx)(card,{className:p.className})}function sidebar(){return(0,j.jsx)(gate,{},`usage-alert`)}';

function render(patched, plan, email = 'member@example.test') {
  const component = analyzeSource(patched, context).component;
  const calls = [];
  const factory = new Function('dataHook', 'atom', 'auth', 'monthly', 'entries', 'buckets', 'managedPlan', 'j', 'merge', component.text + ';return card;');
  const jsx = (type, props) => ({ type, ...props });
  const card = factory(() => ({ data: { plan_type: plan, account_id: 'fixture-account' } }), {}, () => ({ email }), opts => { calls.push(opts); return { data: { effective_monthly_limit: { limit: 100 }, current_month_usage: 25 } }; }, () => [], () => [], p => p != null && plans.includes(p), { jsx, jsxs: jsx }, (...x) => x.join(' '));
  return { text: JSON.stringify(card({})), calls };
}

test('企业套餐使用Monthly，不依赖邮箱；个人套餐和未知套餐不查询月额度', () => {
  const patched = patchSource(source, context).source;
  for (const plan of plans) {
    const result = render(patched, plan);
    assert.match(result.text, /Monthly/);
    assert.doesNotMatch(result.text, /Weekly/);
    assert.deepEqual(result.calls, [{ accountId: 'fixture-account', enabled: true }]);
  }
  for (const plan of ['free', 'plus', 'pro', 'team', null, undefined, 'unknown']) {
    const result = render(patched, plan, 'member@shopee.com');
    assert.match(result.text, /Weekly/);
    assert.doesNotMatch(result.text, /Monthly/);
    assert.equal(result.calls[0].enabled, false);
  }
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(source));
  assert.equal(analyzeSource(patched, context).status, 'already-patched');
});

test('原生企业判定依赖缺失、重复、个人套餐污染或不可达时拒绝补丁', () => {
  const invalid = [
    { ...context, moduleSources: new Map() },
    { ...context, moduleSources: new Map([['assets/plans.js', { text: policyModule.replace('`business`', '`free`') }]]) },
  ];
  for (const ctx of invalid) assert.throws(() => patchSource(source, ctx), /企业账户/);
  assert.throws(() => patchSource(source.replace('enterprisePolicy as managedPlan', 'enterprisePolicy as managedPlan,enterprisePolicy as duplicate'), context), /企业账户/);
  assert.throws(() => patchSource(source.replace('enterprisePolicy as managedPlan', 'other as managedPlan'), context), /企业账户/);
});

test('旧邮箱版v8进入upgrade-ready，新版契约遭篡改时明确拒绝', () => {
  const patched = patchSource(source, context).source;
  const legacy = patched.replace('void`codex-quota-enterprise-plan:v1`;', '').replace(/managedPlan\((\$q\d+)\?\.plan_type\)/, '(`member@shopee.com`).endsWith(`@shopee.com`)');
  // One domain anchor, as in the previous generation.
  const old = legacy.replace('`member@shopee.com`', '`member`');
  assert.equal(analyzeSource(old, context).status, 'upgrade-ready');
  const upgraded = patchSource(old, context).source;
  assert.equal(analyzeSource(upgraded, context).status, 'already-patched');
  assert.equal(Buffer.byteLength(upgraded), Buffer.byteLength(old));
  assert.throws(() => analyzeSource(patched.replace('?.plan_type', '?.email'), context), /企业账户/);
});
