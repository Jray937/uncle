# Uncle 后端 API 说明

本文档整理了前端调用 Uncle 后端（Cloudflare Worker + Hono）的所有可用接口，便于直接复制使用。示例均默认后端基础地址为 `https://<YOUR_WORKER_BASE_URL>`，请替换为实际部署地址。

## 认证与环境

- 当前仓库已启用“demo 模式”：`Authorization` 头会被跳过，后端会固定使用 demo 用户（`sub: demo-user-id`），便于前端联调。
- 生产环境请在请求头中携带 `Authorization: Bearer <Clerk_JWT>`，并在环境变量中配置：
  - `CLERK_ISSUER_URL`：Clerk 的 Issuer 地址
  - `TIINGO_API_TOKEN`：Tiingo 的 API Token（用于行情与新闻）
- 数据库存储使用 Cloudflare D1，持仓表结构见 `schema.sql`。

## 公共接口（无需认证）

| 方法 | 路径 | 说明 | 响应示例 |
| --- | --- | --- | --- |
| GET | `/` | 返回服务欢迎语及基础状态 | `Welcome to Uncle - ...` |
| GET | `/api/public` | 公共示例数据 | `{ "message": "This is public data accessible to anyone." }` |
| GET | `/api/health` | 健康检查 | `{ "status": "ok", "message": "Uncle backend is healthy", "timestamp": "2024-..." }` |

## 受保护接口（demo 模式可直接调用，生产需 Bearer Token）

### 用户信息
- **GET** `/api/private`
- 返回当前用户信息。
```json
{
  "message": "Secure data accessed successfully!",
  "user": { "sub": "demo-user-id", "email": "...", "name": "Demo User" }
}
```

### 股票搜索（Tiingo）
- **GET** `/api/search?query={关键词}`
- 成功返回 Tiingo 搜索数组，字段由 Tiingo 定义。

### 持仓列表
- **GET** `/api/holdings`
- 返回当前用户全部持仓，并附带最新价格（若 Tiingo 可用）。
```json
[
  {
    "id": 1,
    "user_id": "demo-user-id",
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "shares": 10,
    "avg_price": 150,
    "currentPrice": 191.24,
    "priceData": { "ticker": "AAPL", "last": 191.24, "...": "..." }
  }
]
```

### 新增持仓
- **POST** `/api/holdings`
- `Content-Type: application/json`
```json
{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "shares": 10,
  "avg_price": 150
}
```
- 成功响应：
```json
{ "success": true, "id": 2, "message": "Holding added successfully" }
```
- 校验规则：`symbol`/`name` 必填；`shares`、`avg_price` 必须是大于 0 的数字。

### 删除持仓
- **DELETE** `/api/holdings/{id}`
- 成功：`{ "success": true, "message": "Holding deleted successfully" }`
- 未找到或无权限：`404` + `{ "error": "Holding not found or unauthorized" }`

### 新闻列表（Tiingo）
- **GET** `/api/news`
- 根据当前用户持仓的所有 `symbol` 拉取 Tiingo 新闻列表，返回 Tiingo 原始数组。

## 错误返回格式

出现错误时通常返回：
```json
{ "error": "<错误信息>", "details": "<可选的错误描述>" }
```
常见状态码：`400`（参数缺失/非法）、`401`（未授权）、`404`（资源不存在）、`500`（内部错误或第三方失败）。

## 前端快速示例（fetch）

```ts
const BASE = 'https://<YOUR_WORKER_BASE_URL>';
const token = '<Clerk_JWT>'; // demo 模式可留空

async function getHoldings() {
  const res = await fetch(`${BASE}/api/holdings`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error('failed');
  return res.json();
}

async function addHolding() {
  const res = await fetch(`${BASE}/api/holdings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ symbol: 'AAPL', name: 'Apple Inc.', shares: 10, avg_price: 150 })
  });
  return res.json();
}
```

