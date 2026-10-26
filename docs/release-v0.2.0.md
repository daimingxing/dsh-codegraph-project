# v0.2.0 — 模型现在能收到 CodeGraph 的使用说明

## 本次更新

修好了一处信息丢失：模型现在能收到 CodeGraph 自带的完整使用说明。

CodeGraph 本身会在连接时把使用说明提供给客户端，但插件之前没有把它转交给模型，所以模型只看到工具名和简短描述，得自己猜怎么用。现在这份说明会正常送达，查询更准，也更少出现"先 grep 一遍再读文件"的绕路。

只对已建立索引的项目生效，没有 `.codegraph/` 的项目不受影响。

## 安装

```powershell
dsh plugin --profile web add dsh-codegraph-project
```

桌面端在 Plugins 页面搜索 `dsh-codegraph-project` 安装。

本插件依赖 CodeGraph CLI 本身，需自行安装：`npm install -g @colbymchenry/codegraph`。

## 上下文占用

CodeGraph 原生会提供一份使用说明给大模型，占用约 1.7k token。

现在允许用户使用：

```yaml
config:
  injectInstructions: false
```

节约这部分上下文。关掉后工具照常可用，只是不再附带这份说明；你可以在项目的 `AGENTS.md` 里写一份更精简的版本。

## 修复

极少数情况下查询工具没能加载成功，但使用说明还是发给了模型，导致模型去找一个不存在的工具。现在两者保持一致。

---

# v0.2.0 — Models now receive CodeGraph's built-in usage guide

## What's changed

Fixed a case of lost information: models now receive CodeGraph's full built-in usage guide.

CodeGraph sends a usage guide to clients when connecting, but this plugin previously did not forward it to the model. The model only saw tool names and a short description and had to guess how to use them. The guide is now delivered as intended — queries are more accurate, with less of the "grep first, then read files" detour.

Only applies to projects with an index. Projects without `.codegraph/` are unaffected.

## Install

```powershell
dsh plugin --profile web add dsh-codegraph-project
```

On desktop, search `dsh-codegraph-project` in the Plugins page.

This plugin uses the CodeGraph CLI, which you need to install separately: `npm install -g @colbymchenry/codegraph`.

## Context cost

CodeGraph natively provides a usage guide to the model, costing roughly 1.7k tokens.

You can now opt out with:

```yaml
config:
  injectInstructions: false
```

This saves that context. Tools keep working after disabling it; the guide is simply no longer attached. You can write a leaner version in your project's `AGENTS.md` instead.

## Fixes

In rare cases the query tool failed to load while the usage guide was still sent to the model, causing it to look for a tool that did not exist. The two now stay in sync.
