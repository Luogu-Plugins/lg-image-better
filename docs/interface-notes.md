# 上传接口核对记录

核对日期：2026-10-10。以下来自洛谷服务的公开资源；未使用用户账号、未实际上传图片。

## 当前配置

`https://www.luogu.com.cn/_lfe/config` 中确认：

- `image.upload` → `/image/upload`
- `captcha` → `/lg4/captcha`
- `image.list` → `/image`

## 前端依据

入口：`https://fecdn.luogu.com.cn/columba/loader.20261007-2290.js`

图床过程：`https://fecdn.luogu.com.cn/columba/columba~518ed1655eda6007.js`（模块 13482）调用通用上传工具，参数为 `{name:"image.upload"}`、`{watermarkType}`，新上传模式为 true。文件 MIME 必须以 `image/` 开头；图片超过 512000 字节或水印为 0 时计入高级空间。

通用工具：`https://fecdn.luogu.com.cn/columba/columba~f24498a534bd9488.js`（模块 34881）：

1. `/lg4/captcha` 图片。
2. POST `/image/upload`，JSON `{captcha,watermarkType}`。
3. 响应为 `{uploadLink}`。
4. 构造 FormData：`key = uploadLink.dir + filename`、`name`、`uploadLink.fields`、最后追加 `file`。
5. POST 到 `uploadLink.host`。
6. 新存储响应形如 `{success:boolean,response:string}`，其中 `response` 是 JSON；图床页面使用其 `file` 对象，图片地址为 `file.url`。

页面：`https://fecdn.luogu.com.cn/columba/columba~1dd2a4c98bb23ac3.js`（模块 15892）默认水印值为 1，上传成功后将返回的 `file` 放入图片列表。

HTTP 包装：`https://fecdn.luogu.com.cn/columba/vendor.20261007-2290.js` 中模块 37655 的 `Xf` 是 POST；模块 29808 使用 `X-Requested-With: XMLHttpRequest`。入口脚本从 `meta[name="csrf-token"]` 设置 `X-CSRF-TOKEN`。

编辑器：`https://fecdn.luogu.com.cn/columba/cskt~2dae70e98ee36fc9.js` 使用 CodeMirror 6，编辑区域包装为 `.cs-editor`。

## 模型依据

用户提供的 `index (1).user.js`，Amazing Luogu 1.3.9：

- 第 7824 行附近：字符表、模型资源地址、缓存键。
- 第 7880 行附近：模型结构兼容、Base64 权重加载。
- 第 7986 行附近：90 × 35 RGB 输入、归一化、四字符分类。
- 该脚本把自己的 `GM_getValue` 暴露于 `unsafeWindow`，可尝试读取其 `OCRCaptchaCode` 缓存。

资源地址：`https://cdn.amlg.top/amlg/OCRCaptcha.js`。本机下载失败，未确认资源当前内容；本项目不执行下载资源中的脚本，只解析模型数据，不宣称已验证真实推理。

旧的非官方接口资料提及 `/api/image/generateUploadLink`，与当前前端不一致。本项目没有采用该旧接口。
