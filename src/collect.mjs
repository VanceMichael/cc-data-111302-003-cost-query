// 可中止、可恢复的采集作业。
// 执行模型：读能力表 → 规划（发送前可解释）→ 共享领取 → 逐批查询 → 按回执真实扣减 →
// 缺口进入下一轮重规划。收到 402/409/422 时绝不原样重发，而是重新读取能力表后再规划。
// 停止条件：目标达成、预算不足、来源持续不可用（尝试上限）、重规划轮次超限、外部中止、来源故障。
// 状态快照在每批之后落盘（statePath），可用 resumeCollection 从中断点继续。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {getCapabilities, queryFields, readOrganization} from './client.mjs';
import {planCollection} from './planner.mjs';
import {createFieldCache} from './cache.mjs';

const DEFAULT_MAX_ATTEMPTS = 2; // 同一字段最多尝试次数（含首次），防止把失败请求发到成功为止
const DEFAULT_MAX_ROUNDS = 6;   // 重规划轮次上限，防止在代价/版本抖动中无限循环

export function completenessReport(goal, records){
  const perEntity = {};
  let requiredGot = 0; let requiredTotal = 0;
  for(const id of goal.ids){
    const record = records[id] ?? {};
    const got = goal.required.filter(field => record[field] !== undefined);
    const optionalGot = (goal.optional ?? []).filter(field => record[field] !== undefined);
    perEntity[id] = {
      required: {got, missing: goal.required.filter(field => record[field] === undefined)},
      optional: {got: optionalGot, missing: (goal.optional ?? []).filter(field => record[field] === undefined)},
    };
    requiredGot += got.length;
    requiredTotal += goal.required.length;
  }
  return {perEntity, requiredGot, requiredTotal, requiredRatio: requiredTotal === 0 ? 1 : requiredGot / requiredTotal};
}

function validateGoal(options){
  if(typeof options?.source !== 'string') throw new TypeError('需要 source 来源地址');
  const goal = options.goal;
  if(!goal || !Array.isArray(goal.ids) || goal.ids.length === 0) throw new TypeError('goal.ids 必须是非空数组');
  if(!Array.isArray(goal.required)) throw new TypeError('goal.required 必须是数组');
  if(typeof goal.role !== 'string') throw new TypeError('goal.role 必须是字符串');
  if(!Number.isFinite(options.budget) || options.budget < 0) throw new TypeError('budget 必须是非负数值');
}

function newState({goal, budget}){
  return {
    version: 1,
    goal: {ids: [...goal.ids], required: [...goal.required], optional: [...(goal.optional ?? [])], role: goal.role},
    budgetTotal: budget,
    spent: 0,
    records: {},      // 实体 id → 已取得的字段值
    provenance: {},   // "实体 字段" → query | cache | shared
    gaps: {},         // "实体 字段" → {attempts, reason}，仅仍未取得的字段
    receipts: [],
    plans: [],
    cacheSnapshot: null,
    lastVersion: null,
    rounds: 0,
    status: 'running',
    stopReason: null,
    events: [],
  };
}

export async function runCollection(options){
  validateGoal(options);
  return execute(newState(options), options);
}

// 从 statePath（或传入的 state 对象）恢复作业。重规划计数重置，预算与缺口保留；
// 可用 additionalBudget 为恢复后的作业追加预算。
export async function resumeCollection(options){
  if(typeof options?.source !== 'string') throw new TypeError('需要 source 来源地址');
  const state = options.state ?? JSON.parse(await readFile(options.statePath, 'utf8'));
  state.rounds = 0;
  if(options.additionalBudget) state.budgetTotal += options.additionalBudget;
  state.status = 'running';
  return execute(state, options);
}

async function execute(state, options){
  const {source, signal, maxBatchCost = Infinity, statePath} = options;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const cache = options.cache ?? createFieldCache(state.cacheSnapshot);
  const onEvent = options.onEvent ?? (() => {});
  const role = state.goal.role;
  const gapKey = (id, field) => `${id} ${field}`;

  const emit = async event => {
    state.events.push(event);
    if(state.events.length > 200) state.events.shift();
    await onEvent(event);
  };
  const persist = async () => {
    state.cacheSnapshot = cache.toJSON();
    if(!statePath) return;
    await mkdir(dirname(statePath), {recursive: true});
    const tmp = statePath + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 1));
    await rename(tmp, statePath);
  };
  const putRecord = (id, field, value, via) => {
    (state.records[id] ??= {})[field] = value;
    state.provenance[`${id} ${field}`] = via;
    delete state.gaps[gapKey(id, field)];
  };
  const addGap = async (id, field, reason) => {
    const key = gapKey(id, field);
    const gap = state.gaps[key] ??= {id, field, attempts: 0, required: state.goal.required.includes(field)};
    gap.attempts++;
    gap.reason = reason;
    await emit({type: 'gap', id, field, reason, attempts: gap.attempts});
  };

  const finish = async (requested, hint) => {
    // 汇总最终缺口：必需字段进 unmet，可选字段进 skippedOptional，都带原因。
    const unmet = []; const skippedOptional = [];
    const explain = (id, field, plannedList) => {
      const gap = state.gaps[gapKey(id, field)];
      if(gap && gap.attempts >= maxAttempts) return `来源持续不可用（${gap.attempts} 次尝试）：${gap.reason}`;
      const planned = plannedList?.find(entry => entry.id === id && entry.field === field);
      return planned?.reason ?? gap?.reason ?? '未获取';
    };
    for(const id of state.goal.ids){
      for(const field of state.goal.required)
        if(state.records[id]?.[field] === undefined)
          unmet.push({id, field, reason: explain(id, field, state.lastPlan?.unsatisfiable)});
      for(const field of state.goal.optional)
        if(state.records[id]?.[field] === undefined)
          skippedOptional.push({id, field, reason: explain(id, field, state.lastPlan?.skippedOptional)});
    }
    let status = requested;
    if(status === 'complete' && unmet.length > 0) status = 'partial'; // 必需缺口绝不包装成完整成功
    const stopReason = status === 'complete' ? 'goal-met'
      : hint ?? (unmet.some(entry => entry.reason.includes('预算')) ? 'budget-insufficient'
        : unmet.some(entry => entry.reason.includes('持续不可用')) ? 'source-field-unavailable'
        : 'capability-insufficient');
    state.status = status;
    state.stopReason = stopReason;
    await persist();
    const result = {
      status, stopReason,
      records: state.records,
      provenance: state.provenance,
      completeness: completenessReport(state.goal, state.records),
      spend: {total: state.spent, receipts: state.receipts},
      unmet, skippedOptional,
      rounds: state.rounds,
      plans: state.plans,
      state, statePath,
    };
    await emit({type: 'status', status, stopReason, unmet, skippedOptional, spent: state.spent});
    return result;
  };

  while(true){
    if(signal?.aborted) return finish('aborted', 'aborted');
    let capabilities;
    try{
      capabilities = await getCapabilities(source, {signal});
    }catch(error){
      if(signal?.aborted || error?.name === 'AbortError') return finish('aborted', 'aborted');
      return finish('failed', `目录读取失败：${error.message}`);
    }
    if(capabilities.capabilityVersion !== state.lastVersion){
      if(state.lastVersion != null){
        const dropped = cache.sweepVersions(capabilities.capabilityVersion);
        await emit({type: 'replan', cause: 'capability-version', from: state.lastVersion, to: capabilities.capabilityVersion, cacheDropped: dropped});
      }
      state.lastVersion = capabilities.capabilityVersion;
    }
    state.rounds++;
    if(state.rounds > maxRounds) return finish('partial', 'replan-limit');

    // 仍有效的缓存直接并入结果（键含角色与能力版本，不会越权）。
    for(const id of state.goal.ids)
      for(const field of [...state.goal.required, ...state.goal.optional])
        if(state.records[id]?.[field] === undefined){
          const value = cache.get(role, capabilities.capabilityVersion, id, field);
          if(value !== undefined) putRecord(id, field, value, 'cache');
        }

    // 剩余目标 = 未取得且未达到尝试上限的字段。
    const targets = [];
    for(const id of state.goal.ids){
      const need = list => list.filter(field =>
        state.records[id]?.[field] === undefined &&
        (state.gaps[gapKey(id, field)]?.attempts ?? 0) < maxAttempts);
      const required = need(state.goal.required);
      const optional = need(state.goal.optional);
      if(required.length || optional.length) targets.push({id, required, optional});
    }
    const plan = planCollection({
      capabilities, role, targets,
      budget: state.budgetTotal - state.spent,
      maxBatchCost,
      directory: capabilities.directory,
      cached: (id, field) => cache.get(role, capabilities.capabilityVersion, id, field) !== undefined,
    });
    state.lastPlan = plan;
    state.plans.push(plan);
    if(state.plans.length > 20) state.plans.shift();
    await emit({type: 'plan', plan, round: state.rounds, remainingBudget: state.budgetTotal - state.spent});
    if(plan.batches.length === 0 && plan.sharedFetches.length === 0) return finish('complete');

    // 共享机构资料：每个机构一次领取，覆盖所有关联实体。
    for(const shared of plan.sharedFetches){
      let document = cache.get(role, capabilities.capabilityVersion, `org:${shared.orgId}`, 'document');
      let fromCache = document !== undefined;
      if(!fromCache){
        let result;
        try{
          result = await readOrganization(source, shared.orgId, {signal});
        }catch(error){
          if(signal?.aborted || error?.name === 'AbortError') return finish('aborted', 'aborted');
          result = {ok: false, status: '网络错误'};
        }
        if(result.ok){
          document = result.organization;
          cache.put(role, capabilities.capabilityVersion, `org:${shared.orgId}`, {document});
        }else{
          for(const id of shared.ids) await addGap(id, 'organization', `机构 ${shared.orgId} 资料读取失败（${result.status ?? result.error}）`);
          continue;
        }
      }
      for(const id of shared.ids) putRecord(id, 'organization', document, fromCache ? 'cache' : 'shared');
      await emit({type: 'shared', orgId: shared.orgId, ids: shared.ids, fromCache});
    }
    await persist();

    let replan = false;
    for(const batch of plan.batches){
      if(signal?.aborted) return finish('aborted', 'aborted');
      let result;
      try{
        result = await queryFields(source, {
          ids: batch.ids, fields: batch.fields, role,
          capabilityVersion: capabilities.capabilityVersion,
          maxCost: batch.cost, // 按计划报价封顶：来源临时涨价会得到 402，而不是超扣
        }, {signal});
      }catch(error){
        if(signal?.aborted || error?.name === 'AbortError') return finish('aborted', 'aborted');
        return finish('failed', `查询请求失败：${error.message}`);
      }
      if(!result.ok){
        if([402, 409, 422, 400].includes(result.status)){
          // 报价超限 / 能力版本过期 / 计划被拒：重新读取能力表后再规划，绝不原样重发。
          await emit({
            type: 'replan',
            cause: result.status === 402 ? 'quote-exceeded' : result.status === 409 ? 'capability-version' : 'plan-rejected',
            status: result.status, error: result.error, batch,
          });
          replan = true;
          break;
        }
        return finish('failed', `来源返回 ${result.status}：${result.error}`);
      }
      // 真实扣减以回执为准，不以计划估值为准。
      state.spent += result.receipt.cost;
      state.receipts.push({...result.receipt, ids: batch.ids, fields: batch.fields, round: state.rounds});
      await emit({type: 'receipt', receipt: state.receipts[state.receipts.length - 1], spent: state.spent, budgetTotal: state.budgetTotal});
      const returned = new Map((result.records ?? []).map(record => [record.id, record]));
      const errored = new Set((result.errors ?? []).map(entry => `${entry.id} ${entry.field}`));
      for(const [id, record] of returned)
        for(const field of batch.fields)
          if(record[field] !== undefined){
            putRecord(id, field, record[field], 'query');
            cache.put(role, capabilities.capabilityVersion, id, {[field]: record[field]});
          }
      // 部分字段失败：保留已得数据，缺口记入下一轮，仍有价值才重取。
      for(const error of result.errors ?? []) await addGap(error.id, error.field, error.reason ?? '来源拒绝');
      for(const id of batch.ids)
        for(const field of batch.fields){
          const record = returned.get(id);
          if((!record || record[field] === undefined) && !errored.has(`${id} ${field}`))
            await addGap(id, field, '响应缺失');
        }
      await persist();
    }
    if(replan) continue;
    // 本轮批次执行完毕：回到循环头部重新规划剩余缺口；若无缺口，下一轮计划为空并收尾。
  }
}
