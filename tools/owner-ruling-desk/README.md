# Owner 裁定台（本地网页）

把「必须 owner 本人拍板」的事项做成可读的网页表单。提交后写入仓库：

- `docs/decisions/owner-web-rulings/latest.md`
- `docs/decisions/owner-web-rulings/latest.json`
- `docs/decisions/owner-web-rulings/submissions/<时间戳>.*`

开发侧（含本机 AI）读 `latest.md` / `latest.json` 即可。未选题记为「本次跳过」，**不视为默许**。

## 启动

在仓库根目录：

```bash
node tools/owner-ruling-desk/server.mjs
```

浏览器打开：<http://127.0.0.1:8787/>

可选环境变量：

- `OWNER_RULING_HOST`（默认 `127.0.0.1`）
- `OWNER_RULING_PORT`（默认 `8787`）

## 更新题目

编辑 `_build_catalog.py` 后执行：

```bash
python tools/owner-ruling-desk/_build_catalog.py
```

然后刷新页面。
