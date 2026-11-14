// 采集规划层演示：同一本地来源，两种角色、不同预算下的取舍。
// 每个场景都会打印发送前的请求计划、回执真实扣减，以及每条资料的字段完整度。
import {createSource} from './source.mjs';
import {runCollection, resumeCollection} from './collect.mjs';
import {formatPlan} from './planner.mjs';

const source = await createSource();
const control = body => fetch(source.url + '/control', {method: 'POST', body: JSON.stringify(body)}).then(response => response.json());
const summary = [];

function reporter(title){
  console.log(`\n=== ${title} ===`);
  return async event => {
    if(event.type === 'plan') console.log(formatPlan(event.plan, {remainingBudget: event.remainingBudget}));
    if(event.type === 'shared') console.log(`共享领取｜机构 ${event.orgId} → ${event.ids.join('、')}（${event.fromCache ? '缓存命中' : '新取'}）`);
    if(event.type === 'receipt') console.log(`回执 ${event.receipt.id}｜扣费 ${event.receipt.cost}｜累计 ${event.spent}/${event.budgetTotal}`);
    if(event.type === 'gap') console.log(`缺口｜${event.id}.${event.field}｜${event.reason}（第 ${event.attempts} 次尝试）`);
    if(event.type === 'replan') console.log(`重新规划｜${event.cause}${event.error ? `｜${event.error}` : ''}`);
  };
}

function show(title, result){
  console.log(`结果｜状态 ${result.status}（${result.stopReason}）｜实际花费 ${result.spend.total}｜必需完整度 ${result.completeness.requiredGot}/${result.completeness.requiredTotal}`);
  for(const [id, entry] of Object.entries(result.completeness.perEntity))
    console.log(`  ${id}｜必需已得 ${entry.required.got.join('+') || '无'}｜必需缺失 ${entry.required.missing.join('+') || '无'}｜可选已得 ${entry.optional.got.join('+') || '无'}｜可选缺失 ${entry.optional.missing.join('+') || '无'}`);
  for(const entry of result.unmet) console.log(`  不可满足｜${entry.id}.${entry.field}｜${entry.reason}`);
  for(const entry of result.skippedOptional) console.log(`  跳过可选｜${entry.id}.${entry.field}｜${entry.reason}`);
  summary.push({title, status: result.status, spent: result.spend.total, completeness: `${result.completeness.requiredGot}/${result.completeness.requiredTotal}`});
}

try{
  // A：普通角色、预算充足——共享机构一次领取，contact 因角色权限被明确跳过
  show('A 普通角色 reader，预算 30', await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'organization'], optional: ['history', 'contact'], role: 'reader'},
    budget: 30,
    onEvent: reporter('A reader 预算30'),
  }));

  // B：同一目标、预算收紧——可选字段按剩余预算取舍，取舍原因可见
  show('B 普通角色 reader，预算 8', await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'organization'], optional: ['history', 'contact'], role: 'reader'},
    budget: 8,
    onEvent: reporter('B reader 预算8'),
  }));

  // C：管理员、预算充足——history 与 contact 互斥，自动拆批
  show('C 管理员 admin，预算 30', await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'contact'], optional: ['history'], role: 'admin'},
    budget: 30,
    onEvent: reporter('C admin 预算30'),
  }));

  // D：管理员、预算仅够必需——可选展开被放弃并说明
  show('D 管理员 admin，预算 9', await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'contact'], optional: ['history'], role: 'admin'},
    budget: 9,
    onEvent: reporter('D admin 预算9'),
  }));

  // E：字段代价在响应前上涨——402 触发重规划，而不是把原请求发到成功为止
  {
    const report = reporter('E 代价中途上涨');
    let changed = false;
    show('E 字段代价中途上涨（reader，预算 20）', await runCollection({
      source: source.url,
      goal: {ids: ['p1', 'p2'], required: ['name'], optional: ['history'], role: 'reader'},
      budget: 20,
      maxBatchCost: 7,
      onEvent: async event => {
        await report(event);
        if(event.type === 'receipt' && !changed){ changed = true; await control({costChange: {history: 20}}); }
      },
    }));
    await control({costChange: {history: 6}});
  }

  // F：能力版本中途迁移——409 使缓存失效并重规划
  {
    const report = reporter('F 能力版本迁移');
    let bumped = false;
    show('F 能力版本中途迁移（admin，预算 20）', await runCollection({
      source: source.url,
      goal: {ids: ['p1', 'p2'], required: ['name', 'contact'], optional: [], role: 'admin'},
      budget: 20,
      maxBatchCost: 4,
      onEvent: async event => {
        await report(event);
        if(event.type === 'receipt' && !bumped){ bumped = true; await control({bumpVersion: true}); }
      },
    }));
  }

  // G：中止与恢复——状态落盘后可从断点继续，不重复扣费
  {
    const statePath = '.local/collect-demo-resume.json';
    const controller = new AbortController();
    const report = reporter('G 中止与恢复');
    let receipts = 0;
    const aborted = await runCollection({
      source: source.url,
      goal: {ids: ['p1', 'p2'], required: ['name', 'organization'], optional: ['history'], role: 'reader'},
      budget: 30,
      maxBatchCost: 7,
      statePath,
      signal: controller.signal,
      onEvent: async event => {
        await report(event);
        if(event.type === 'receipt' && ++receipts === 1) controller.abort();
      },
    });
    console.log(`中止｜状态 ${aborted.status}｜已花费 ${aborted.spend.total}，状态已写入 ${statePath}`);
    console.log('—— 从断点恢复 ——');
    show('G 恢复后继续（reader，预算沿用）', await resumeCollection({source: source.url, statePath, onEvent: reporter('G 恢复')}));
  }

  // H：预算不足——必需缺口明确列出，状态为 partial 而非完整成功
  show('H 预算不足的必需字段（reader，预算 4）', await runCollection({
    source: source.url,
    goal: {ids: ['p1', 'p2'], required: ['name', 'history'], optional: [], role: 'reader'},
    budget: 4,
    onEvent: reporter('H 预算4'),
  }));

  console.log('\n=== 汇总 ===');
  for(const row of summary) console.log(`${row.title}｜${row.status}｜花费 ${row.spent}｜必需完整度 ${row.completeness}`);
}finally{
  await source.close();
}
