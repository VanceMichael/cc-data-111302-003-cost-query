// 采集结果复用缓存。键 = 授权角色 + 能力版本 + 实体：
// 管理员角色取到的字段不会流向普通账号；来源能力版本变化后旧条目整体失效。
export function createFieldCache(snapshot){
  const entries = new Map(snapshot?.entries ?? []);
  const keyOf = (role, version, id) => JSON.stringify([role, version, id]);
  return {
    get(role, version, id, field){
      return entries.get(keyOf(role, version, id))?.fields?.[field];
    },
    put(role, version, id, fields){
      const key = keyOf(role, version, id);
      const entry = entries.get(key) ?? {fields: {}};
      Object.assign(entry.fields, fields);
      entries.set(key, entry);
    },
    // 能力版本迁移：丢弃所有非当前版本的条目，返回丢弃数量。
    sweepVersions(keepVersion){
      let removed = 0;
      for(const key of [...entries.keys()]){
        if(JSON.parse(key)[1] !== keepVersion){ entries.delete(key); removed++; }
      }
      return removed;
    },
    get size(){ return entries.size; },
    toJSON(){ return {entries: [...entries]}; },
  };
}
