# 月薪喵

> 由 `npm run new:pet -- yuexin-miao "月薪喵"` 生成

## 还缺什么

**26 张图**，规格见 [`pet-spec.json`](../../pet-spec.json)：

| 项 | 要求 |
|---|---|
| 尺寸 | **512 × 512**，透明背景 |
| 格式 | `.webp` |
| 构图 | 内容居中，**占高约 85%** |
| 源图 | 留在 `pet-art/yuexin-miao/`（**别删**）|


**26 张，一张不能少：**

| 逻辑名 | 文件名 | 用在哪 | 好了吗 |
|---|---|---|---|
| `awake` | `idle_pillow_awake.webp` | idle、wave、balanceOk、awake、blinkTwice、待机:awake、待机:blinkTwice | ⬜ |
| `patHappy` | `idle_pillow_pat.webp` | patHappy | ⬜ |
| `eat` | `idle_pillow_eat.webp` | eat、待机:eat | ⬜ |
| `stretch` | `idle_pillow_stretch.webp` | stretch、待机:stretch | ⬜ |
| `angry` | `idle_pillow_angry.webp` | angry | ⬜ |
| `angryBlock` | `idle_pillow_angry_block.webp` | angry | ⬜ |
| `blink` | `idle_pillow_blink.webp` | idle、blink、slowBlink、blinkTwice、待机:blink、待机:slowBlink、待机:blinkTwice | ⬜ |
| `drowsy` | `idle_pillow_drowsy.webp` | drowsy、balanceLow | ⬜ |
| `sleep` | `idle_pillow_sleep.webp` | sleep | ⬜ |
| `startle` | `idle_pillow_startle.webp` | startle | ⬜ |
| `wave1` | `idle_pillow_wave_1.webp` | wave | ⬜ |
| `wave2` | `idle_pillow_wave_2.webp` | wave | ⬜ |
| `work0` | `working_0.webp` | working | ⬜ |
| `work1` | `working_0_1.webp` | working | ⬜ |
| `work2` | `working_1.webp` | working | ⬜ |
| `work3` | `working_1_2.webp` | working | ⬜ |
| `work4` | `working_2.webp` | working | ⬜ |
| `work5` | `working_2_3.webp` | working | ⬜ |
| `work6` | `working_3.webp` | working | ⬜ |
| `needInput` | `need_input.webp` | needInput | ⬜ |
| `blocked` | `blocked.webp` | balanceCritical、blocked | ⬜ |
| `ready0` | `ready_0.webp` | — | ⬜ |
| `ready1` | `ready_1.webp` | ready | ⬜ |
| `ready2` | `ready.webp` | ready | ⬜ |
| `ready3` | `ready_3.webp` | ready | ⬜ |
| `ready4` | `ready_4.webp` | ready | ⬜ |

## 怎么补

```bash
# ① 生成候选（AI，火山方舟 Seedream）
python3 tools/gen-frames.py --action <动作名> --count 3 --process --webp

# ② 挑一张登记进 manifest
python3 tools/add-frame.py --style yuexin-miao --logical awake --from <选中的png>

# ③ 随时查还缺哪些
npm run verify:pet -- yuexin-miao
```

**做完了要接线**：`src/renderer/pet.js` 的 `ACTIVE_STYLE` / `FRAME_FILES`，
以及 `manifest.json` 里的 `name`。

完整流程见 [`docs/pet-workflow.md`](../../docs/pet-workflow.md)。
