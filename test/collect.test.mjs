import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {runCollection, resumeCollection} from '../src/collect.mjs';
import {createFieldCache} from '../src/cache.mjs';

async function withSource(callback){
  const source = await createSource();
  try{ return await callback(source); }
  finally{ await source.close(); }
}
const control = (source, body) =>
  fetch(source.url + '/control', {method: 'POST', body: JSON.stringify(body)}).then(response => response.json());

test('计划在发送前可解释，回执真实扣减，字段完整度可见', () => withSource(async source => {
  const events = [];
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'organization'], optional: ['history', 'contact'], role: 'reader'},
    budget: 30,
    onEvent: event => events.push(event),
  });
  assert.equal(result.status, 'complete');
  const planIndex = events.findIndex(event => event.type === 'plan');
  const receiptIndex = events.findIndex(event => event.type === 'receipt');
  assert.ok(planIndex !== -1 && receiptIndex !== -1 && planIndex < receiptIndex, '计划必须先于任何请求');
  assert.ok(events[planIndex].plan.explanations.length > 0, '计划必须附带解释');
  assert.equal(result.spend.total, 14); // 2 实体 × (name 1 + history 6)，机构共享领取不计费
  assert.equal(result.spend.receipts.reduce((sum, receipt) => sum + receipt.cost, 0), result.spend.total);
  assert.equal(result.completeness.requiredRatio, 1);
  assert.equal(result.records.p1.organization.name, '联合机构');
  assert.deepEqual(result.records.p2.history, ['h2']);
  assert.deepEqual(result.completeness.perEntity.p1.optional.missing, ['contact']);
  assert.ok(result.skippedOptional.some(entry => entry.field === 'contact' && entry.reason.includes('无权')));
}));

test('预算不足时必需缺口明确列出，绝不包装成完整成功', () => withSource(async source => {
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'history'], optional: [], role: 'reader'},
    budget: 4,
  });
  assert.equal(result.status, 'partial');
  assert.notEqual(result.status, 'complete');
  assert.equal(result.stopReason, 'budget-insufficient');
  assert.equal(result.completeness.requiredRatio, 0.5);
  assert.deepEqual(result.unmet.map(entry => `${entry.id}.${entry.field}`), ['p1.history', 'p2.history']);
  assert.ok(result.unmet.every(entry => entry.reason.includes('预算')));
  assert.equal(result.records.p1.name, '甲', '已取得的字段必须保留');
  assert.equal(result.spend.total, 2);
}));

test('同一机构资料只领取一次，不按实体字段计费', () => withSource(async source => {
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['organization'], optional: [], role: 'reader'},
    budget: 0,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.spend.total, 0);
  assert.equal(source.state.receipts.length, 0, '共享领取不应产生计费回执');
  assert.equal(result.records.p1.organization.name, '联合机构');
  assert.equal(result.records.p2.organization.id, 'org1');
}));

test('缓存按授权角色与能力版本隔离，管理员字段不给普通账号', () => withSource(async source => {
  const cache = createFieldCache();
  const adminGoal = {ids: ['p1', 'p2'], required: ['contact'], optional: [], role: 'admin'};
  const first = await runCollection({source: source.url, goal: adminGoal, budget: 10, cache});
  assert.equal(first.status, 'complete');
  assert.equal(first.spend.total, 6);
  assert.equal(source.state.receipts.length, 1);

  const reader = await runCollection({source: source.url, goal: {ids: ['p1', 'p2'], required: ['contact'], optional: [], role: 'reader'}, budget: 10, cache});
  assert.equal(reader.status, 'partial');
  assert.equal(reader.spend.total, 0, '普通角色不得为无权字段付费');
  assert.equal(reader.records.p1?.contact, undefined, '管理员缓存的 contact 不得泄露给 reader');
  assert.ok(reader.unmet.every(entry => entry.reason.includes('无权')));

  const second = await runCollection({source: source.url, goal: adminGoal, budget: 10, cache});
  assert.equal(second.status, 'complete');
  assert.equal(second.spend.total, 0, '同角色同版本应直接复用缓存');
  assert.equal(second.records.p1.contact, 'a@example.test');
  assert.equal(source.state.receipts.length, 1, '全程只有第一次管理员查询产生计费');
}));

test('部分字段失败：保留已得数据，只重取缺口，按回执真实扣减', () => withSource(async source => {
  await control(source, {deniedFields: ['history']});
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'history'], optional: [], role: 'reader'},
    budget: 40,
    maxAttempts: 2,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'source-field-unavailable');
  assert.equal(result.records.p1.name, '甲');
  assert.equal(result.records.p2.name, '乙');
  assert.deepEqual(result.unmet.map(entry => `${entry.id}.${entry.field}`), ['p1.history', 'p2.history']);
  assert.match(result.unmet[0].reason, /持续不可用/);
  assert.equal(result.spend.total, 28, '两轮各 14，失败的字段同样按回执计费');
  assert.equal(result.spend.receipts.length, 2, '重取只针对缺口，且有尝试上限');
  assert.ok(result.rounds <= 4, '不得无限重试');
}));

test('字段代价在响应前变化：重新规划而不是原样重发', () => withSource(async source => {
  const events = [];
  let changed = false;
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name'], optional: ['history'], role: 'reader'},
    budget: 20,
    maxBatchCost: 7,
    onEvent: async event => {
      events.push(event);
      if(event.type === 'receipt' && !changed){ changed = true; await control(source, {costChange: {history: 20}}); }
    },
  });
  assert.equal(result.status, 'complete');
  assert.ok(events.some(event => event.type === 'replan' && event.cause === 'quote-exceeded'), '402 应触发重规划');
  assert.deepEqual(result.records.p1.history, ['h1']);
  assert.equal(result.records.p2.history, undefined, '涨价后的可选字段应被放弃而非硬取');
  assert.ok(result.skippedOptional.some(entry => entry.id === 'p2' && entry.field === 'history'));
  assert.equal(result.spend.total, 8); // 7（涨价前）+ 1（重规划后只取 name）
  const p2Receipts = result.spend.receipts.filter(receipt => receipt.ids.includes('p2'));
  assert.deepEqual(p2Receipts.map(receipt => receipt.fields), [['name']], 'p2 不得按原价原样重发');
}));

test('能力版本过期：缓存失效并重规划，而不是反复撞 409', () => withSource(async source => {
  const events = [];
  const cache = createFieldCache();
  let bumped = false;
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'contact'], optional: [], role: 'admin'},
    budget: 20,
    maxBatchCost: 4,
    cache,
    onEvent: async event => {
      events.push(event);
      if(event.type === 'receipt' && !bumped){ bumped = true; await control(source, {bumpVersion: true}); }
    },
  });
  assert.equal(result.status, 'complete');
  assert.ok(events.some(event => event.type === 'replan' && event.cause === 'capability-version'));
  assert.ok(events.some(event => event.type === 'replan' && event.cacheDropped > 0), '旧版本缓存必须被清除');
  assert.equal(result.spend.total, 8);
  assert.equal(result.records.p2.contact, 'b@example.test');
  assert.equal(result.spend.receipts.filter(receipt => receipt.ids.includes('p2')).length, 1, 'p2 只应在新版本下取一次');
}));

test('采集作业可中止并从中断点恢复，不重复扣费', async () => withSource(async source => {
  const dir = await mkdtemp(join(tmpdir(), 'collect-'));
  try{
    const statePath = join(dir, 'job.json');
    const controller = new AbortController();
    let receipts = 0;
    const aborted = await runCollection({
      source: source.url,
      goal: {ids: ['p1', 'p2'], required: ['name', 'organization'], optional: ['history'], role: 'reader'},
      budget: 30,
      maxBatchCost: 7,
      statePath,
      signal: controller.signal,
      onEvent: event => { if(event.type === 'receipt' && ++receipts === 1) controller.abort(); },
    });
    assert.equal(aborted.status, 'aborted');
    assert.equal(aborted.spend.total, 7);
    assert.deepEqual(aborted.records.p1.history, ['h1']);
    assert.equal(aborted.records.p2.name, undefined);

    const resumed = await resumeCollection({source: source.url, statePath});
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.spend.total, 14, '恢复后累计扣费应包含中止前的 7');
    assert.deepEqual(resumed.records.p2.history, ['h2']);
    assert.equal(resumed.records.p1.organization.name, '联合机构');
    assert.equal(source.state.receipts.length, 2, 'p1 的已取字段不得重复计费');
  }finally{
    await rm(dir, {recursive: true, force: true});
  }
}));

test('未知字段与未知实体不被静默丢弃', () => withSource(async source => {
  const result = await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'ghost'], required: ['name', 'salary'], optional: [], role: 'reader'},
    budget: 20,
  });
  assert.equal(result.status, 'partial');
  assert.ok(result.unmet.some(entry => entry.id === 'p1' && entry.field === 'salary' && entry.reason.includes('没有字段')));
  assert.ok(result.unmet.some(entry => entry.id === 'ghost' && entry.reason.includes('不在来源目录')));
  assert.equal(result.records.p1.name, '甲');
  assert.equal(result.spend.total, 1, '只有可满足的字段产生计费');
}));
