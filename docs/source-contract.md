# 来源协议

POST /query 接受 ids、fields、role、capabilityVersion、maxCost。费用为每个实体每个字段的 fields 权重之和，organization 可另行通过 /organizations/org1 领取一次。dependencies 声明字段前置，incompatible 给出不能一起展开的字段；违约返回422且不计费。普通角色 contact 局部失败，但仍计查询费用。能力版本不符返回409且不计费。实际代价超过 maxCost 返回402且不披露。/control 支持 costChange、deniedFields、bumpVersion。/inventory 是能力及实体标识。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
