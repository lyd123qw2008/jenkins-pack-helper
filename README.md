# Jenkins Pack Helper

## 作用
提供命令行/网页构建辅助工具 + Jenkins 页面油猴插件，用于提取构建结果与历史记录。

## 功能
- CLI/Web：触发参数化/非参数化构建并提取结果
- 油猴插件：在 Jenkins 页面展示最近构建历史并一键复制执行结果

## 安装
```powershell
python -m pip install -r requirements.txt
```

## 配置
复制 `config.example.json` 为 `config.json` 并按需修改：
```powershell
Copy-Item config.example.json config.json
```

### 说明
- `jenkins.base_url` 形如 `https://jenkins.xxx.com`
- `jenkins.user` 为 Jenkins 账号；优先使用 `jenkins.api_token`，其次 `jenkins.password`，都为空时会提示输入密码（或使用环境变量 `JENKINS_PASS`）
- `jobs` 下定义每个构建任务
- `success_patterns` 是正则，匹配到的 **最后一条** 会作为结果
- `result_template` 可用 `{match}` 代表匹配到的文本

## 使用
### 1) 触发 docker 包构建
```powershell
python pack_helper.py build docker
```

### 2) 触发文档包构建（需要参数）
```powershell
python pack_helper.py build doc --param name=5g-os-console-doc --param SVN=svn://xxx/xxx
```

### 3) 同时构建多个（顺序执行）
```powershell
python pack_helper.py build docker doc --param name=5g-os-console-doc --param svn_path=svn://xxx/xxx
```

### 4) 结果复制到剪贴板
```powershell
python pack_helper.py build docker --copy
```

## Web 页面
### 启动
```powershell
python web_app.py
```
打开浏览器访问 `http://127.0.0.1:5000`。

### 页面能力
- 配置 Jenkins 地址/账号/密码
- 选择多个任务并一键构建
- 展示结果并一键复制

## 油猴插件（Tampermonkey）
### 安装
1) 安装 Tampermonkey
2) 新建脚本，粘贴 `jenkins-pack-helper.user.js`
3) 保存后访问 `http://192.169.2.50:9081/`

### 使用
- 页面右侧会出现 Jenkins Pack Helper 面板（默认折叠，记忆展开状态）
- All 自动按 Jenkins 全局构建流拉取最新构建并按时间倒序展示，滚动到底部会继续加载更早记录，后续可手动 Refresh
- 列表点击即可抓取 console 输出并按规则提取结果，同时自动复制
- By Job 支持搜索切换 job，并查询该 job 自己的 build 历史，可继续加载更早构建
- Build History 下拉菜单增加「复制结果」
- Config 支持 Tree/Code 查看与编辑

### 默认配置（Config JSON）
字段说明：
- `rules`：规则列表，按顺序匹配，命中即停止
- `rules[].name`：规则名称（仅用于标识）
- `rules[].job_pattern`：正则，匹配浏览器路径 `/job/<jobName>` 中的 job 名
- `rules[].success_patterns`：正则数组，取 **最后一次** 匹配；若正则有捕获组，优先取第一个捕获组
- `rules[].result_template`：输出模板，`{match}` 代表匹配到的文本
- `debug`：是否输出调试日志（默认关闭）
- `auto_poll_building`：是否轮询刷新 “building” 的构建状态（默认关闭）

```json
{
  "rules": [
    {
      "name": "docker",
      "job_pattern": "^FXYF2_docker.*",
      "success_patterns": [
        ".*?(镜像仓库：[^，,]+[，,]镜像版本：V[0-9.]+\\.[0-9]+[，,]已成功推送至：\\S+\\s*仓库项目中，自动化镜像构建脚本运行完成！)"
      ],
      "result_template": "{match}"
    },
    {
      "name": "doc",
      "job_pattern": "^FXYF2_doc.*",
      "success_patterns": [
        ".*?([^\\r\\n]+?\\.zip已打包好[，,]?请到以下路径提取包进行测试。[^\\r\\n]*)"
      ],
      "result_template": "{match}"
    },
    {
      "name": "send_doc",
      "job_pattern": "^5gsend-Platform-.*_doc$",
      "success_patterns": [
        ".*?([^\\r\\n]+?\\.zip\\s*已发送到珠海平台[^\\r\\n]*目录中，请知悉！)"
      ],
      "result_template": "{match}"
    },
    {
      "name": "send_docker",
      "job_pattern": "^5gsend-Platform-send-docker$",
      "success_patterns": [
        ".*?([\\w./-]+:V[0-9.]+(?:\\.[0-9]+)?已发送到珠海平台:[^\\s]+目录中，请知悉！)"
      ],
      "result_template": "{match}"
    },
    {
      "name": "fallback",
      "job_pattern": ".*",
      "success_patterns": [
        ".*?([^\\r\\n]+?\\.zip已打包好[，,]?请到以下路径提取包进行测试。[^\\r\\n]*)"
      ],
      "result_template": "{match}"
    }
  ],
  "debug": false,
  "auto_poll_building": false
}
```

### 产出示例
```
5g-os-console-doc_V3.67.1.1.zip已打包好，请到以下路径提取包进行测试。ftp://192.169.2.6/5G消息产品线/5G消息产品线研发二部
镜像仓库：5g-platform-test/5g-os-console，镜像版本：V3.67.1.765，已成功推送至：https://192.169.2.237:8004 仓库项目中，自动化镜像构建脚本运行完成！
```

## 常见问题
- CSRF 开启时，脚本会自动尝试获取 crumb
- 如果 Jenkins 走自签名证书，可在 config 里把 `verify_ssl` 设为 false
- 油猴插件默认仅首次自动拉取一次历史，后续请手动 Refresh（可在 Config 中开启 `auto_poll_building`）
