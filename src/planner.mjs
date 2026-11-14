// 按采集目标组织请求的规划层。
// 输入：来源能力表（字段代价、依赖、互斥、角色权限）、采集目标（实体 × 必需/可选字段）、剩余预算。
// 输出：发送前即可解释的计划——批次、共享机构领取、明确列出的不可满足必需字段与被跳过的可选字段。
// 规划器是纯函数，不发请求；任何字段不会被静默丢弃，要么进批次，要么带着原因进入 unsatisfiable / skippedOptional。

const ORGANIZATION_FIELD = 'organization';

export function planCollection({capabilities, role, targets, budget, maxBatchCost = Infinity, cached = () => false, directory = {}}){
  const fields = capabilities?.fields ?? {};
  const dependencies = capabilities?.dependencies ?? {};
  const incompatible = capabilities?.incompatible ?? [];
  const allowed = capabilities?.roles?.[role];
  const entityIds = capabilities?.entityIds;
  const plan = {batches: [], sharedFetches: [], unsatisfiable: [], skippedOptional: [], totalExpectedCost: 0, explanations: []};
  if(!Array.isArray(targets) || targets.length === 0) return plan;
  let remaining = Math.max(0, budget ?? 0);

  // 字段的依赖闭包，依赖在前；同一请求必须带上闭包内全部字段。
  const closureOf = field => {
    const order = []; const seen = new Set();
    const visit = f => { if(seen.has(f)) return; seen.add(f); for(const dep of dependencies[f] ?? []) visit(dep); order.push(f); };
    visit(field);
    return order;
  };
  // 把 field 放进 group 是否会凑齐某条互斥组合。
  const violates = (groupFields, field) =>
    incompatible.some(pair => pair.includes(field) && pair.every(f => f === field || groupFields.has(f)));
  const clusterSelfCompatible = cluster => !incompatible.some(pair => pair.every(f => cluster.includes(f)));

  const perEntity = new Map();
  for(const target of targets) perEntity.set(target.id, {groups: []});
  const sharedOrg = new Map(); // orgId → Set(实体 id)
  const entityMissing = id => Array.isArray(entityIds) && !entityIds.includes(id);

  // 先必需后可选：必需字段在所有实体上优先于任何可选字段。
  for(const tier of ['required', 'optional']){
    const sink = tier === 'required' ? plan.unsatisfiable : plan.skippedOptional;
    for(const target of targets){
      if(entityMissing(target.id)){
        for(const field of target[tier] ?? []) sink.push({id: target.id, field, reason: `实体 ${target.id} 不在来源目录中`});
        continue;
      }
      const entry = perEntity.get(target.id);
      for(const field of target[tier] ?? []){
        const deny = reason => sink.push({id: target.id, field, reason});
        if(cached(target.id, field)) continue; // 缓存仍有效，无需再取
        if(!Object.hasOwn(fields, field)){ deny(`来源能力表没有字段 ${field}`); continue; }
        if(!allowed){ deny(`角色 ${role} 不在来源能力表中`); continue; }
        if(!allowed.includes(field)){ deny(`角色 ${role} 无权获取字段 ${field}`); continue; }
        if(field === ORGANIZATION_FIELD && directory[target.id]){
          // 共享机构资料经专门入口一次领取，替代按实体计费的字段展开。
          const orgId = directory[target.id];
          if(!sharedOrg.has(orgId)){
            sharedOrg.set(orgId, new Set());
            plan.explanations.push(`机构 ${orgId} 的共享资料经专门入口领取一次，替代按实体各扣 ${fields[field]} 的 ${ORGANIZATION_FIELD} 字段`);
          }
          sharedOrg.get(orgId).add(target.id);
          continue;
        }
        const cluster = closureOf(field);
        const unknownDep = cluster.find(f => !Object.hasOwn(fields, f));
        if(unknownDep){ deny(`字段 ${field} 依赖来源不存在的字段 ${unknownDep}`); continue; }
        const deniedDep = cluster.find(f => !allowed.includes(f));
        if(deniedDep){ deny(`字段 ${field} 依赖角色 ${role} 无权获取的字段 ${deniedDep}`); continue; }
        if(!clusterSelfCompatible(cluster)){ deny(`字段 ${field} 的依赖闭包内部互斥，无法同批展开`); continue; }
        // 选组：同实体已安排的组里，兼容且追加代价最小者；否则另起一组。
        const groups = entry.groups;
        let best = null; let bestMarginal = Infinity; let sawIncompatible = false;
        for(const group of groups){
          if(cluster.some(f => violates(group.fields, f))){ sawIncompatible = true; continue; }
          const marginal = cluster.reduce((sum, f) => sum + (group.fields.has(f) ? 0 : fields[f]), 0);
          if(marginal < bestMarginal){ bestMarginal = marginal; best = group; }
        }
        let isNewGroup = false;
        if(!best){
          best = {fields: new Set()};
          bestMarginal = cluster.reduce((sum, f) => sum + fields[f], 0);
          groups.push(best);
          isNewGroup = true;
        }
        const rollback = () => { if(isNewGroup) groups.pop(); };
        if(bestMarginal > remaining){
          deny(`字段 ${field} 需追加代价 ${bestMarginal}，剩余预算 ${remaining} 不足`);
          rollback();
          continue;
        }
        const groupCostAfter = [...best.fields].reduce((sum, f) => sum + fields[f], 0) + bestMarginal;
        if(Number.isFinite(maxBatchCost) && groupCostAfter > maxBatchCost){
          deny(`字段 ${field} 加入后单批代价 ${groupCostAfter} 超过单批上限 ${maxBatchCost}`);
          rollback();
          continue;
        }
        for(const f of cluster) best.fields.add(f);
        remaining -= bestMarginal;
        if(sawIncompatible && isNewGroup) plan.explanations.push(`实体 ${target.id} 的 ${field} 与已安排字段互斥，拆分为独立批次`);
        if(cluster.length > 1) plan.explanations.push(`实体 ${target.id} 的 ${field} 依赖 ${cluster.slice(0, -1).join('、')}，同批展开，追加代价 ${bestMarginal}`);
      }
    }
  }

  // 同名字段签名合并成批，再按单批上限切分。
  const buckets = new Map();
  for(const target of targets){
    for(const group of perEntity.get(target.id).groups){
      if(group.fields.size === 0) continue;
      const signature = [...group.fields].sort();
      const key = signature.join(' ');
      if(!buckets.has(key)) buckets.set(key, {fields: signature, ids: []});
      buckets.get(key).ids.push(target.id);
    }
  }
  for(const bucket of buckets.values()){
    const perEntityCost = bucket.fields.reduce((sum, f) => sum + fields[f], 0);
    let chunk = [];
    const flush = () => {
      if(chunk.length === 0) return;
      const cost = perEntityCost * chunk.length;
      plan.batches.push({ids: chunk, fields: bucket.fields, cost, reason: `${chunk.length} 个实体 × 字段 ${bucket.fields.join('+')}`});
      plan.totalExpectedCost += cost;
      chunk = [];
    };
    for(const id of bucket.ids){
      if(Number.isFinite(maxBatchCost) && chunk.length > 0 && perEntityCost * (chunk.length + 1) > maxBatchCost) flush();
      chunk.push(id);
    }
    flush();
  }
  for(const [orgId, ids] of sharedOrg)
    plan.sharedFetches.push({kind: 'organization', orgId, ids: [...ids], reason: `机构 ${orgId} 共享资料一次领取，覆盖 ${ids.size} 个实体`});
  return plan;
}

// 把计划渲染成发送前可审阅的文本。
export function formatPlan(plan, {remainingBudget} = {}){
  const lines = [`请求计划｜预计总代价 ${plan.totalExpectedCost}${remainingBudget === undefined ? '' : `｜剩余预算 ${remainingBudget}`}`];
  plan.batches.forEach((batch, index) =>
    lines.push(`  批次 ${index + 1}｜实体 ${batch.ids.join('、')}｜字段 ${batch.fields.join('+')}｜预计 ${batch.cost}｜${batch.reason}`));
  for(const shared of plan.sharedFetches)
    lines.push(`  共享领取｜机构 ${shared.orgId}｜覆盖 ${shared.ids.join('、')}｜${shared.reason}`);
  for(const note of plan.explanations) lines.push(`  说明｜${note}`);
  for(const entry of plan.unsatisfiable) lines.push(`  不可满足（必需）｜${entry.id}.${entry.field}｜${entry.reason}`);
  for(const entry of plan.skippedOptional) lines.push(`  跳过（可选）｜${entry.id}.${entry.field}｜${entry.reason}`);
  return lines.join('\n');
}
