function signalWithTimeout(signal, ms){
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function inspect(url){
  const response=await fetch(url+'/inventory',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`目录读取失败: ${response.status}`);
  return response.json();
}
export async function readRaw(url,path){
  const response=await fetch(url+path,{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`资料读取失败: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// 读取来源能力表：字段代价、依赖、互斥、角色权限、能力版本，以及实体→机构目录。
export async function getCapabilities(url, {signal} = {}){
  const response = await fetch(url + '/inventory', {signal: signalWithTimeout(signal, 2000)});
  if(!response.ok) throw new Error(`目录读取失败: ${response.status}`);
  const inventory = await response.json();
  const directory = {};
  for(const entity of inventory.entities ?? [])
    if(entity?.id && entity.organization) directory[entity.id] = entity.organization;
  return {
    capabilityVersion: inventory.capabilityVersion,
    fields: inventory.fields ?? {},
    dependencies: inventory.dependencies ?? {},
    incompatible: inventory.incompatible ?? [],
    roles: inventory.roles ?? {},
    directory,
    entityIds: (inventory.entities ?? []).map(entity => entity.id),
  };
}

// 按字段查询。业务错误（402/409/422/400 等）不抛异常，返回结构化结果交由规划层决策；
// 只有网络层面的失败才抛出。
export async function queryFields(url, {ids, fields, role, capabilityVersion, maxCost}, {signal} = {}){
  const response = await fetch(url + '/query', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ids, fields, role, capabilityVersion, maxCost}),
    signal: signalWithTimeout(signal, 4000),
  });
  let value = {};
  try{ value = await response.json(); }catch{}
  if(!response.ok) return {ok: false, status: response.status, error: value.error ?? `HTTP ${response.status}`};
  return {ok: true, records: value.records ?? [], errors: value.errors ?? [], receipt: value.receipt};
}

// 共享机构资料经专门入口一次领取。
export async function readOrganization(url, orgId, {signal} = {}){
  const response = await fetch(`${url}/organizations/${orgId}`, {signal: signalWithTimeout(signal, 2000)});
  if(!response.ok) return {ok: false, status: response.status, error: `机构资料读取失败: ${response.status}`};
  return {ok: true, organization: await response.json()};
}
