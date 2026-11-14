import test from 'node:test';
import assert from 'node:assert/strict';
import {planCollection, formatPlan} from '../src/planner.mjs';

const capabilities = {
  capabilityVersion: 1,
  fields: {name: 1, organization: 2, history: 6, contact: 3},
  dependencies: {history: ['name']},
  incompatible: [['history', 'contact']],
  roles: {
    reader: ['name', 'organization', 'history'],
    admin: ['name', 'organization', 'history', 'contact'],
  },
};

test('依赖闭包：请求 history 自动带上 name 并计入代价', () => {
  const plan = planCollection({capabilities, role: 'reader', targets: [{id: 'p1', required: ['history'], optional: []}], budget: 100});
  assert.deepEqual(plan.batches[0].fields, ['history', 'name']);
  assert.equal(plan.batches[0].cost, 7);
  assert.ok(plan.explanations.some(line => line.includes('依赖')));
});

test('互斥字段拆分为不同批次，且说明原因', () => {
  const plan = planCollection({capabilities, role: 'admin', targets: [{id: 'p1', required: ['history', 'contact'], optional: []}], budget: 100});
  assert.equal(plan.batches.length, 2);
  for(const batch of plan.batches)
    assert.ok(!(batch.fields.includes('history') && batch.fields.includes('contact')), '互斥字段不得同批');
  assert.ok(plan.explanations.some(line => line.includes('互斥')));
});

test('必需字段不可满足时明确列出，绝不静默删除', () => {
  const plan = planCollection({capabilities, role: 'reader', targets: [{id: 'p1', required: ['contact', 'salary'], optional: []}], budget: 100});
  assert.equal(plan.batches.length, 0, '不可满足的字段不得进入批次');
  assert.deepEqual(plan.unsatisfiable.map(entry => entry.field).sort(), ['contact', 'salary']);
  assert.match(plan.unsatisfiable.find(entry => entry.field === 'contact').reason, /无权/);
  assert.match(plan.unsatisfiable.find(entry => entry.field === 'salary').reason, /没有字段/);
});

test('预算不足区分必需与可选：必需进不可满足，可选进跳过', () => {
  const requiredPlan = planCollection({capabilities, role: 'reader', targets: [{id: 'p1', required: ['history'], optional: []}], budget: 3});
  assert.equal(requiredPlan.batches.length, 0);
  assert.match(requiredPlan.unsatisfiable[0].reason, /预算/);
  const optionalPlan = planCollection({capabilities, role: 'reader', targets: [{id: 'p1', required: ['name'], optional: ['history']}], budget: 3});
  assert.deepEqual(optionalPlan.batches.map(batch => batch.fields), [['name']]);
  assert.equal(optionalPlan.skippedOptional[0].field, 'history');
  assert.match(optionalPlan.skippedOptional[0].reason, /预算/);
});

test('同一机构共享资料一次领取，替代按实体计费', () => {
  const plan = planCollection({
    capabilities, role: 'reader',
    targets: [{id: 'p1', required: ['organization'], optional: []}, {id: 'p2', required: ['organization'], optional: []}],
    budget: 10,
    directory: {p1: 'org1', p2: 'org1'},
  });
  assert.equal(plan.batches.length, 0, '机构字段不应按实体计费');
  assert.equal(plan.sharedFetches.length, 1);
  assert.deepEqual(plan.sharedFetches[0].ids, ['p1', 'p2']);
  assert.equal(plan.totalExpectedCost, 0);
});

test('单批上限触发拆批', () => {
  const plan = planCollection({
    capabilities, role: 'reader',
    targets: ['p1', 'p2', 'p3'].map(id => ({id, required: ['name'], optional: []})),
    budget: 100, maxBatchCost: 1,
  });
  assert.equal(plan.batches.length, 3);
  assert.ok(plan.batches.every(batch => batch.cost <= 1));
});

test('缓存仍有效的字段不再安排请求', () => {
  const plan = planCollection({
    capabilities, role: 'reader',
    targets: [{id: 'p1', required: ['name'], optional: []}],
    budget: 100,
    cached: (id, field) => id === 'p1' && field === 'name',
  });
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.totalExpectedCost, 0);
});

test('计划在发送前可解释：批次、代价与原因齐备', () => {
  const plan = planCollection({capabilities, role: 'admin', targets: [{id: 'p1', required: ['name', 'contact'], optional: ['history']}], budget: 100});
  const text = formatPlan(plan, {remainingBudget: 100});
  assert.match(text, /请求计划｜预计总代价/);
  assert.match(text, /批次 1｜实体 p1｜字段/);
  assert.match(text, /contact/);
  assert.match(text, /互斥/);
});

test('未知实体与未知角色不会被静默放行', () => {
  const withIds = {...capabilities, entityIds: ['p1']};
  const plan = planCollection({capabilities: withIds, role: 'reader', targets: [{id: 'ghost', required: ['name'], optional: []}], budget: 100});
  assert.equal(plan.batches.length, 0);
  assert.match(plan.unsatisfiable[0].reason, /不在来源目录/);
  const noRole = planCollection({capabilities, role: 'guest', targets: [{id: 'p1', required: ['name'], optional: []}], budget: 100});
  assert.equal(noRole.batches.length, 0);
  assert.match(noRole.unsatisfiable[0].reason, /不在来源能力表/);
});
