# YASA C 调用图评测（Clang 参考集 / CodeGraph / GNU cflow）

> 日期：2026-11-08 · 范围：仅 C（新 parser 暂不支持 C++）· 对象：调用图准确率（非漏洞检测）

## 指标说明（P / R / F1）

- **P（Precision，精确率/查准率）** = TP / (TP + FP)：工具输出的调用边里，有多少是正确的。
- **R（Recall，召回率/查全率）** = TP / (TP + FN)：Clang 参考集里的调用边，有多少被工具找到了。
- **F1** = 2 × P × R / (P + R)：精确率与召回率的调和平均，综合衡量。
- **TP**（真阳性）= 工具输出且参考集也有的边；**FP**（假阳性）= 工具输出但参考集没有的边；**FN**（假阴性）= 参考集有但工具漏掉的边。

> P/R/F1 越接近 1 越好；只看 P 或只看 R 都容易失真（少输出能提高 P，多输出能提高 R），因此要结合 F1 判断。

## 1. 结论速览

| 项目 | YASA P/R/F1 | CodeGraph P/R/F1 | cflow P/R/F1 |
|---|---|---|---|
| zlib | 0.000 / 0.000 / 0.000 | 0.926 / 0.818 / 0.869 | **1.000 / 0.900 / 0.948** |
| lz4 | 0.961 / 0.929 / **0.945** | 0.970 / 0.884 / 0.925 | 0.972 / 0.673 / 0.795 |
| jansson | 1.000 / 0.983 / **0.991** | 0.998 / 0.849 / 0.917 | 0.978 / 0.915 / 0.945 |
| libpng | 1.000 / 0.041 / 0.078 | 0.985 / 0.807 / 0.887 | **0.982 / 0.969 / 0.976** |

- YASA 在 **lz4（0.945）、jansson（0.991）** 上最好，等于或优于 CodeGraph；
- YASA 在 **zlib / libpng** 上全图不完整（库项目无 main，entrypoint=0），见最后一节；
- cflow 精度最高（0.98–1.00），lz4 召回偏低（0.673）；
- CodeGraph 稳定（0.87–0.93），无极端失败。

## 2. 项目

| 项目 | 版本 / commit |
|---|---|
| zlib | v1.4 `99623ef` |
| lz4 | main `d04dab31`（tag v1.9.2） |
| jansson | v2.15.1 `851a214` |
| libpng | v1.6.59 `a70313db` |

## 3. 实验步骤

1. 用 Clang + CMake 构建各项目，生成 `compile_commands.json`；
2. `extract_clang_gold.py` 对每个 TU 执行 `clang -fsyntax-only -Xclang -ast-dump=json`，提取项目内（.c 定义的）函数与 **直接调用**（`CallExpr` → `DeclRefExpr.referencedDecl`，即 getDirectCallee 语义），形成 gold 图；
3. YASA：`--language c --analyzer CAnalyzer --cTarget linux --cUnknownMacros undefined --checkerIds callgraph --dumpAllCG` → `callgraph.json`；
4. CodeGraph：`codegraph init --yes <project>` → `.codegraph-wsl/codegraph.db`；
5. cflow：`cflow --brief -I <项目/构建目录> <作用域 .c 文件>`，按缩进树解析调用边；
6. 统一映射到 gold 的 `(文件, 函数)` 定义集合，去重后计算 TP/FP/FN 与 P/R/F1。

**作用域**：zlib 根目录 `.c`；lz4 `lib/` + `programs/`；jansson `src/`；libpng 根目录 `png*.c`。三工具使用同一作用域。

## 4. 数据大小

| 项目 | TU | 内部函数定义 | Clang 直接调用边 |
|---|---:|---:|---:|
| zlib | 30 | 160 | 231 |
| lz4 | 17 | 583 | 1100 |
| jansson | 13 | 243 | 530 |
| libpng | 16 | 518 | 907 |

Clang 提取失败：**0**。

## 5. 各工具结果

| 项目 | 工具 | 预测边 | TP | FP | FN |
|---|---|---:|---:|---:|---:|
| zlib | YASA | 0 | 0 | 0 | 231 |
| zlib | CodeGraph | 204 | 189 | 15 | 42 |
| zlib | cflow | 208 | 208 | 0 | 23 |
| lz4 | YASA | 1063 | 1022 | 41 | 78 |
| lz4 | CodeGraph | 1002 | 972 | 30 | 128 |
| lz4 | cflow | 761 | 740 | 21 | 360 |
| jansson | YASA | 521 | 521 | 0 | 9 |
| jansson | CodeGraph | 451 | 450 | 1 | 80 |
| jansson | cflow | 496 | 485 | 11 | 45 |
| libpng | YASA | 37 | 37 | 0 | 870 |
| libpng | CodeGraph | 743 | 732 | 11 | 175 |
| libpng | cflow | 895 | 879 | 16 | 28 |

## 6. 观察

- **YASA 的 C UAST/调用图在正常程序（lz4/jansson）上质量很高**：jansson 仅漏 9 条，lz4 漏 78 条且误报 41 条。
- **cflow 在 zlib/libpng 上召回最高**（0.90/0.97），但 lz4 只召回 0.673，说明其跨文件/宏场景覆盖不稳定。
- **CodeGraph 稳定但召回普遍偏低**（0.81–0.88），jansson 上误报仅 1 条。
- 三个工具的结果都由同一份 Clang 参考集评分，口径一致。

## 7. 复现与产物

```bash
# Clang 参考集
python3 /mnt/d/yasa_new/benchmark/scripts/extract_clang_gold.py --project zlib \
  --compile-db /home/xzg/work/yasa-bench/zlib/build/compile_commands.json \
  --source-root /mnt/d/yasa_new/benchmark/projects/zlib \
  --include-regex '^[^/]+\.c$' --out /mnt/d/yasa_new/benchmark/reference/zlib-clang-gold.json \
  --log /mnt/d/yasa_new/benchmark/logs/zlib-clang-gold.log

# YASA（WSL）
cd /mnt/d/yasa_new/yasa-uast-migration/engine
node dist/main.js --sourcePath /mnt/d/yasa_new/benchmark/projects/lz4 \
  --language c --analyzer CAnalyzer --cTarget linux --cUnknownMacros undefined \
  --checkerIds callgraph --dumpAllCG \
  --ruleConfigFile resource/example-rule-config/rule_config_c.json \
  --report /mnt/d/yasa_new/benchmark/results/yasa-wsl-lz4/report

# CodeGraph / cflow / 评分
codegraph init --yes <project>
python3 /mnt/d/yasa_new/benchmark/scripts/parse_cflow.py ...
python3 /mnt/d/yasa_new/benchmark/scripts/score_tools.py ...
```

产物目录：`D:\yasa_new\benchmark\{projects,reference,results,scripts,logs,generated}`。

## 8. 局限

- gold 节点限定为 `.c` 中定义的函数，头文件 static inline 不计；
- YASA 在 WSL 运行，CodeGraph/cflow 同在 WSL；Windows 版仅作交叉验证（节点/边数完全一致）；
- 样本为 4 个中等规模项目，不能外推为全部 C 工程。

## 9. 目前需修复的问题

1. **YASA 在无 `main` 的库项目上全图不完整**：zlib 扫描到 74 文件，但 `Valid entrypoints: 0`，`dumpAllCG` 仅产出 **4 条边**（0 召回）；libpng 仅 37 条边（召回 **4.1%**）。这是 `CAnalyzer` 的入口点策略问题，不是 UAST 解析失败。
   - 建议：在 `dumpAllCG` 模式下把**所有已定义函数**作为分析根（库模式），或在无可识别 main 时回退到「全部函数」；修复后重跑 zlib/libpng 才能得到公平指标。
2. **建议补充**：为每个项目记录精确耗时/峰值 RSS（本轮 WSL 耗时受 `/mnt/d` 9p 影响：zlib 39s、lz4 58s、jansson 90s、libpng 43s），并用同一硬件与串行口径报告。


