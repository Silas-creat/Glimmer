# 日记双门入口视觉与交互验收

final result: passed

日期：2026-11-12。范围：用户指定 diary.html 的主图替换与左右门入口；沿用既有底部导航和功能页。

## 设计依据与证据

- 原始视觉：用户提供的设计原图（2000×1152，本机保留，未随仓库提供）。
- 项目资产：`前端参考/assets/diary/doors.jpg`；与原图 SHA256 一致，未重绘、变形或改写资产。
- 实现：[日记入口](http://localhost:8080/diary.html)。
- 浏览器截图：[diary-doors.jpg](images/diary-doors.jpg)（668×710）；[diary-doors-mobile.jpg](images/qa/diary-doors-mobile.jpg)（393×852）；[diary-doors-narrow.jpg](images/qa/diary-doors-narrow.jpg)（320×568）；[diary-doors-desktop.jpg](images/qa/diary-doors-desktop.jpg)（1440×900）。
- 浏览器 DPR=1，CSS 视口与截图像素一致；临时尺寸覆盖在测试后已重置。
- 组合对比：[diary-doors-compare-final.jpg](images/qa/diary-doors-compare-final.jpg)、[diary-doors-compare-mobile.jpg](images/qa/diary-doors-compare-mobile.jpg)、[diary-doors-compare-narrow.jpg](images/qa/diary-doors-compare-narrow.jpg)。

组合图左侧以原图按对应视口等比缩放/居中裁切，右侧是实际浏览器主内容截图；去掉底部68px导航后对齐比较。原图不是含界面的设计稿，因此新增入口文字和保留导航属于明确的交互要求，不判为图像不一致。默认和手机组合图已同时打开比对；门轮廓、比例、纹理及颜色一致。整图足以清晰看到门扇、标签与焦点，无需另做细部放大。

## 五项视觉核对

| 表面 | 结果 |
|---|---|
| 字体与层级 | 延续 PingFang SC / Microsoft YaHei 系统字体；12–15px入口文字，左右两门标签完整，无截断。 |
| 间距与布局 | 图片和门热区共用原图坐标，门扇完整；窄竖屏保留上下米色留白以避免拉伸或裁门；桌面保留既有960px内容栏。 |
| 颜色 | 原图蓝/暖双门保持；标签为对应深蓝/棕文字，米色背景，焦点轮廓可见。 |
| 图像质量 | 使用用户原图，哈希一致；按比例显示，不生成替代素材；仅响应式视窗裁掉侧景。 |
| 文案 | 左门“留下我的痕迹”，右门“看看 ta 的”，保持旧功能入口含义。 |

## 交互验证

- 实际点击左门进入 `diary-mine.html`，页面标题“我的日记”，显示日历。
- 实际点击右门进入 `diary-public.html?feed=follow`，页面标题“看看ta的”，当前账号显示既有空状态。
- 门下两处文字也可点击；左右分别实测跳转。
- 键盘 Tab 焦点有深色轮廓；Enter 实测进入“我的日记”。
- 393×852、320×568 无横向页面溢出；门和底部导航可见。1440×900桌面画面已检查。
- 日记入口控制台 error/warn 为空。

## 迭代记录

1. 初版图片/门热区已正确，但胶囊标签不可点击，属于 P2 操作暗示与实际行为不一致。
2. 将两标签改成相同目标的原生链接，增加自身 focus-visible；重新加载、点击左右标签、键盘Enter均通过。上述 final/mobile/narrow/desktop 截图为修复后版本。
3. 手机尺寸改变后的首帧截图短暂使用旧画布；重新加载并检查 innerWidth/innerHeight 后保存最终截图，未把瞬时画布误报为页面缺陷。

无待修 P0/P1/P2。边界：未测试真实手机系统安全区与所有浏览器；原有底部导航的语义/配色不属于本次修改范围。
