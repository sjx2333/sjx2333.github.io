# KOTOBA AI 题库练习

KOTOBA AI 是一个日语 JLPT 题库练习工具，支持通过 GitHub Pages 安装为手机 PWA。题目按题号顺序显示，答题记录保存在本地。

本项目的基础界面和部分功能设计借鉴自 [KotobaAI](https://github.com/Bekzat070101/KotobaAI)。

## 当前功能

- N3、N2 题库练习
- N1 题库位置预留
- 按题号顺序连续练习，直到当前题库完成
- 答题前隐藏中文翻译
- 答题后显示中文翻译、正确答案和完整解析
- 文字题目标词下划线
- 答错或点击“不会”自动加入对应错题本
- N2、N3 分别拥有独立错题本
- 错题本中可以点击“移出错题本”
- PWA 离线缓存
- 使用手机本地存储保存答题记录

## 题库入口

首页有四个练习入口：

```text
N3
N3 错题本
N2
N2 错题本
```

普通题库只显示尚未完成的题目。答错题不会再次混入普通题库，而是进入对应错题本。错题本中的题目只有点击“移出错题本”后才会移除。

## 手机使用方法

### 1. 准备 GitHub Pages 文件

将本项目中的网页文件上传到 GitHub 仓库根目录。目录结构应为：

```text
index.html
bank.html
bank.js
bank.css
style.css
effects.js
sw.js
manifest.webmanifest
logo_icon.png
question_banks/
  n3.json
  n2.json
```

不要再额外套一层文件夹上传，网页文件应直接位于仓库根目录。

### 2. 开启 GitHub Pages

进入 GitHub 仓库：

```text
Settings -> Pages
```

在 `Build and deployment` 中选择：

```text
Source: Deploy from a branch
Branch: main
Folder: / (root)
```

点击 `Save`，等待 GitHub 完成部署。

### 3. 在手机安装

用手机浏览器打开 GitHub Pages 地址，例如：

```text
https://你的用户名.github.io/仓库名/
```

在浏览器菜单中选择“添加到主屏幕”或类似选项：

```text
分享 -> 添加到主屏幕 -> 添加
```

第一次打开需要联网，等待题库加载完成。之后可以断网使用。

## 更新网页

修改或新增题库后：

1. 上传对应文件到 GitHub。
2. 点击 `Commit changes`。
3. 等待 GitHub Pages 重新部署。
4. 在手机浏览器中刷新网页。

如果手机仍然显示旧版本：

1. 关闭主屏幕上的 PWA。
2. 用手机浏览器打开网页并刷新。
3. 必要时删除旧 PWA，再重新添加到主屏幕。

## 添加题库

题库文件放在仓库根目录的：

```text
question_banks/
```

文件名必须使用小写等级名称：

```text
n1.json
n2.json
n3.json
```

题库使用分组格式：

```json
{
  "groups": [
    {
      "data": {
        "unit": "Unit 1",
        "title": "文字・語彙",
        "questions": [
          {
            "id": "001",
            "category": "文字",
            "question": "問題文",
            "options": {
              "1": "選択肢A",
              "2": "選択肢B",
              "3": "選択肢C",
              "4": "選択肢D"
            },
            "answer_index": 1,
            "translation": "中文翻译",
            "explanation": {
              "correct": "正确选项解析",
              "other_options": {
                "2": "错误选项解析"
              }
            }
          }
        ]
      }
    }
  ]
}
```

`answer_index` 使用 `1` 到 `4`，对应四个选项。

## 数据保存

### 手机模式

答题进度保存在当前手机浏览器的本地存储中：

- 不上传答题记录
- 不需要服务器保存进度
- 换手机不会自动同步
- 清除手机浏览器的网站数据可能会丢失进度

## 文件结构

```text
index.html                     网站入口
bank.html                      题库页面
bank.js                        出题、答题和本地逻辑
bank.css                       题库页面样式
manifest.webmanifest           PWA 配置
sw.js                          离线缓存
question_banks/                题库文件
  n2.json
  n3.json
```

## License

[GPL-3.0](LICENSE) © Bekzat070101
