<p align="center">
  <img src="src/assets/brand/foodprint-128.png" width="104" height="104" alt="随食记 Logo：折叠地图、定位点与木勺">
</p>

<h1 align="center">随食记 · foodprint</h1>

<p align="center"><strong>一份放在真实地图上的私人饮食日记。</strong></p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

<p align="center">
  <a href="#features">功能与演示</a> ·
  <a href="#start">下载与使用</a> ·
  <a href="#why">为什么做、相关研究</a> ·
  <a href="#credits">致谢、License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows_x64-597464?style=flat-square" alt="平台：Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-9b6d45?style=flat-square" alt="许可：GPL-3.0-only"></a>
</p>

---

现在的我，对很多东西都没什么购买欲望了，游戏也不太想玩，但我依然会期待一顿好吃的饭。走进一家喜欢的小店，点上几道想吃的菜，坐下来慢慢吃完，对我来说就是生活里很温暖的一段时间。

有时候，过了很久再看到一家店的照片，我会想起那天吃过什么、走过哪条街，还有当时的心情。我希望能把这些经历留下来，让多年后的自己还有机会重新想起它们。

于是我做了 FoodMap，一份放在真实地图上的私人饮食日记。我可以在地图上标出吃过的餐厅，记录每次用餐的时间、照片和想说的话。随着记录越来越多，原本普通的街道也会慢慢变成属于自己的食物记忆地图。

希望以后再打开某个熟悉的地点时，我能想起的不只是那道菜，还有当时那一小段温暖的生活。

<a id="features"></a>

## ✨ 功能与演示

### 地图与用餐记录

在地图上标出一家店，选一个喜欢的小店图标，记下评分和感受。同一家店的每次用餐分别保存；点开某次记录，就能看到那天的时间、照片和写下的话。

![在约克地图上点开 Willow Table，回看一次用餐的时间、备注和食物照片](docs/media/map-to-memory.gif)

### 从相册找到那家店

按餐厅筛选照片，打开一张，再点“在地图中查看”，就能回到所属餐厅和那顿饭的记录。

![在相册筛选并打开图片，回到所属餐厅和用餐记录](docs/media/gallery-to-map.gif)

<a id="start"></a>

## 🚀 下载与使用

适用于 **Windows x64**，当前版本 **0.1.0**。

1. **安装并打开。** 运行 `随食记_0.1.0_x64-setup.exe`，按提示安装，再从开始菜单打开“随食记”。
2. **找到想记录的地方。** 点击地图侧栏的“+”搜索地点，选择“缓存此处周边”，以后就能离线查看。
3. **记下第一顿饭。** 在地图上右键添加餐厅，打开它，新增用餐记录，填写时间、感受，再添加图片或视频。
4. **留一份备份。** 在设置中导出备份，保存到自己容易找回的位置。

餐饮记录和媒体保存在本机；地点搜索和新地图下载会联网。更多说明见[数据与备份](DATA_SAFETY.md)，开发者可阅读[源码运行与构建](docs/development.md)。

<a id="why"></a>

## 💡 为什么做、相关研究

**参考文献**

**1. Food-evoked nostalgia（食物唤起的怀旧情绪）**  
Reid 等，2023，*Cognition and Emotion*，37(1)，34–48。[期刊原文](https://doi.org/10.1080/02699931.2022.2142525)。三项研究发现，食物能够唤起与个人经历有关、以积极情感为主的怀旧体验。

**2. Food nostalgia and food comfort: the role of social connectedness（食物怀旧、慰藉与社会联结）**  
Reid 等，2026，*Cognition and Emotion*，40(1)，217–225。[期刊原文](https://doi.org/10.1080/02699931.2025.2479170)。四项研究考察食物怀旧与慰藉的关系，其中两项实验发现，回想并描述具有怀旧意义的食物经历，能够通过增强与他人的联结感带来慰藉。

**3. What versus where: Investigating how autobiographical memory retrieval differs when accessed with thematic versus spatial information（主题与地点如何影响自传体记忆的提取）**  
Sheldon、Chu，2017，*Quarterly Journal of Experimental Psychology*，70(9)，1909–1921。[期刊原文](https://doi.org/10.1080/17470218.2016.1215478)。研究比较事件主题与空间地点这两种回忆线索。主题线索带来更多记忆实例和总体细节；地点线索让参与者更快找到相关记忆，叙述中与某次具体经历有关的情节细节所占比例也更高。

**设计参考与应用**

地点线索的研究尤其贴近我选择地图的原因：回忆一家店时，附近的街道也可能是记忆的一部分。同一家店保留不同时间的记录，让每一餐的照片和文字都对应到具体的地点与经历。食物怀旧的研究则呼应了我想留下这些记录的理由：那些饭菜带来的温暖，往往也连着当时的人和生活。

<a id="credits"></a>

## 🙏 致谢、License

感谢 OpenFreeMap、OpenMapTiles 与 OpenStreetMap contributors 提供地图资源。项目使用的开源组件、地图和字体，其许可及署名见[第三方说明](THIRD_PARTY_NOTICES.md)。

Copyright (C) 2026 **Lucian W. (lucian-d-w)**。项目原创代码与自有美术素材采用 **[GPL-3.0-only](LICENSE)**，仅适用 GNU GPL 第 3 版。第三方代码和素材保留各自的许可。
