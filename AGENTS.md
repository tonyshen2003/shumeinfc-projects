# AGENTS.md

## 项目概览
NFC 签到 H5 页面，使用 Web NFC API（浏览器原生），由扣子编程托管。

## 技术栈
- 原生 HTML + CSS + JavaScript（无框架）
- Web NFC API（NDEFReader，浏览器原生）
- 扣子工作流 Webhook（数据推送，可选）

## 文件结构
```
index.html    # 单页面主文件（内嵌 CSS + JS）
start.sh      # 部署启动脚本（处理端口环境变量）
.coze         # 项目配置（构建/运行命令）
DESIGN.md     # 设计规范
AGENTS.md     # 项目说明
```

## 兼容性说明
- **Android Chrome 89+**：完整支持 Web NFC
- **iOS Safari**：不支持 Web NFC（页面会提示使用 Android 设备）
- **飞书内置浏览器**：不支持 Web NFC（提示用户在系统浏览器中打开）
- 需要 HTTPS 安全上下文

## 配置项
代码顶部 `<script>` 标签内有一个全局常量：
- `COZE_WEBHOOK` - 扣子工作流 Webhook 地址（可选，未配置时仅展示卡号）

## 核心流程
1. 页面加载 → 检测 Web NFC 支持
2. 用户点击按钮 → `new NDEFReader()` → `reader.scan()` 开始扫描
3. 贴卡 → `onreading` 回调 → 提取 `event.serialNumber` 作为卡号
4. 展示卡号 + 签到时间
5. 如配置了 Webhook → POST `{ cardUid, timestamp }` 推送数据

## 构建与运行
- 纯静态页面，无需构建步骤
- 开发预览：`sh start.sh`（内部读取 `DEPLOY_RUN_PORT`，默认 5000）
- 部署：由扣子托管，通过 `start.sh` 启动静态文件服务
