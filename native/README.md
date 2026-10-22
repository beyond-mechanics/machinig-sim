# ネイティブ版 (Windows): 切りくず生成 FEM

Web 版 (リポジトリ直下) は軽量版として残し、より詳細な計算はネイティブ版で行う。
構成は Tauri + Rust: 画面は Web 版の Three.js をそのまま使い、重い計算は Rust のコアで行う。

## 構成

```
native/
  Cargo.toml                 ワークスペース
  crates/chipfem/            2 次元 平面ひずみ 陽解法 FEM (切りくず生成)
    src/material.rs          Johnson–Cook (Web 版の Oxley 予測と同じ定数)、物性
    src/mesh.rs              3 角形メッシュ、形状関数、境界
    src/solver.rs            陽解法 (中心差分、質量スケーリング)、平均節点圧力、Jaumann + J2 リターンマップ、熱
    src/tool.rs              刃先丸みつきの剛体工具、符号付き距離
    src/remesh.rs            リメッシュ (境界の打ち直し、四分木の種点、制約付き Delaunay、状態量の写像)
    src/cutting.rs           直交切削の段取り・実行・結果 (切削抵抗、切りくず厚さ、温度)
    examples/orthogonal.rs   コマンドラインで実行し、温度と塑性ひずみの分布を SVG に出す
    tests/verify.rs          閉じた解との比較
    tests/cutting.rs         S50C の直交切削を Oxley 理論と比較
  app/                       Windows アプリ (Tauri v2)
    ui/index.html            画面: フライス加工 (Web 版を同梱) と 切りくず FEM
    src-tauri/               Rust 側 (FEM を別スレッドで実行し、進み具合をイベントで画面へ)
```

単位系: mm, s, t (トン), N, MPa, mJ, °C (密度 t/mm³、比熱 mJ/(t·K) = 10⁶ × J/(kg·K)、熱伝導率 mJ/(s·mm·K) = W/(m·K))。

## ロードマップ

| 段階 | 内容 | 状態 |
|---|---|---|
| M1 | FEM の核: 線形 3 角形 + 平均節点圧力 (体積ロック回避)、Jaumann 速度の J2 塑性 (Johnson–Cook、ひずみ速度・温度)、塑性発熱 (β) と熱伝導、剛体工具 (刃先丸み) の運動学的接触とクーロン摩擦、摩擦発熱 | 済 |
| M2 | 切りくず生成: 要素がつぶれる前に被削材を作り直す (境界の取り出し → 刃先近くを細かく → 制約付き Delaunay → 状態量の写像)。分離基準なしで刃先の丸みで材料が上下に分かれる (AdvantEdge と同じ考え方)。切削抵抗・せん断角・切りくず厚さ・温度分布 | 済 |
| M3 | Windows アプリ (Tauri): Web 版の画面に「切りくず FEM」画面 (応力・温度・ひずみの色分け、力の時間変化)。GitHub Actions で Windows インストーラー | 骨組み済 (CI で確認中) |
| M4 | 本体との連携: FEM の切削抵抗から切削係数 (Ktc Krc、エッジ係数) を出してフライスのシミュレーションへ。Oxley 予測・実測波形の同定との比較 | |
| 以降 | 工具の熱伝導 (工具温度と摩耗)、せん断型 (鋸歯状) 切りくずの損傷モデル、3 次元 (斜め切削) | |

## 検証 (`cargo test --release`)

- 平面ひずみ圧縮 (摩擦なし): 応力が Johnson–Cook の (2/√3)·σ_y((2/√3)|ln h/h₀|) と 1.2 % 以内 (ひずみ 0.05〜0.3)。断熱 β = 1 で塑性仕事 = 蓄えた熱、塑性仕事は σ_y の積分と 2 % 以内
- すくい面で弾性の棒を押す: 力が平面ひずみの E/(1−ν²)·(u/L)·H と 0.2 %
- 逃げ面で押し付けながら滑らせる: 摩擦力 / 押し付け力 = 0.28 (μ = 0.3、刃先の丸みの部分の斜めの接触と、くっついている節点の分だけ小さい)

## 直交切削の結果 (M2)

S50C (AISI 1045)、切削速度 200 m/min、切取り厚さ 0.1 mm、すくい角 5°、逃げ角 7°、刃先丸み 0.02 mm、μ = 0.6、切削長 1 mm (幅 1 mm あたり、後半 40 % の平均)。比較は Web 版の Oxley 予測 (同じ Johnson–Cook 定数、鋭い刃先、摩擦角はその釣り合いから 30.4° ≈ μ 0.59)。

![S50C 直交切削の温度と塑性ひずみ](docs/s50c_orthogonal.png)

| | FEM | Oxley |
|---|---|---|
| 主分力 Fc | 220 N/mm | 196 N/mm (+12 %) |
| 背分力 Ft | 83 N/mm | 93 N/mm (−10 %) |
| 切りくず厚さ | 0.232 mm | 0.229 mm (+1.5 %) |
| せん断角 | 24.0° | 24.3° |
| 最高温度 | 947 °C (すくい面) | 793 °C (工具–切りくず界面の平均) |

計算時間 約 18 秒 (4 コア、要素 約 1600、リメッシュ 126 回)。

**感度** (同じ条件で 1 つだけ変える):

| | Fc | Ft | 切りくず厚さ | 最高温度 |
|---|---|---|---|---|
| 標準 (刃先の要素 0.0125 mm、質量スケーリング 100 倍) | 220 | 83 | 0.232 | 947 |
| 刃先の要素を 0.006 mm に (計算 105 秒) | 209 (−5 %) | 68 (−18 %) | 0.263 (+13 %) | 1094 (+15 %) |
| 質量スケーリングを 20 倍に (計算 44 秒) | 232 (+6 %) | 77 (−7 %) | 0.236 (+2 %) | 949 (0 %) |

主分力と、質量スケーリングに対しては安定。背分力・切りくず厚さ・温度は刃先の要素の大きさで 1〜2 割動く: すくい面の第 2 せん断域 (摩擦で張り付く薄い層) の解像度に依存するため。単純なクーロン摩擦は、刃先近くの高い面圧で摩擦応力が材料のせん断強さを超えうるので、次は摩擦応力をせん断強さで頭打ちにする (せん断摩擦・付着–すべりモデル) ことと、メッシュ収束の確認を行う。

## Windows アプリ (M3)

`native/app`: Tauri v2。画面は 2 つのタブで、「フライス加工」は Web 版のオフライン 1 ファイル版 (`dist/machining-sim-offline.html` を `ui/mill.html` として同梱)、「切りくず FEM」は条件の入力、計算中の切削抵抗のグラフ、温度・塑性ひずみ・相当応力の分布 (約 0.5 秒ごとに更新)、定常値の表。FEM は Rust 側の別スレッドで動き、「止める」で途中終了できる。

インストーラー (.msi / .exe) は GitHub Actions (`.github/workflows/native.yml`) の Windows ランナーで作り、成果物 `machining-sim-windows` として取り出せる。Linux のランナーでは FEM のテストを回す。

## ビルド

```
cd native
cargo test --release                                   # FEM の検証と直交切削の回帰テスト
cargo run --release --example orthogonal -- S50C 200 0.1 5 1.0 out.svg 0.6
```

Windows でアプリを作るには、Rust と Node.js を入れてから:

```
npm ci && npm run build                                # Web 版 (フライス加工タブ)
copy dist\machining-sim-offline.html native\app\ui\mill.html
npm install -g @tauri-apps/cli@2
cd native\app\src-tauri && tauri build              # native\target\release\bundle に .msi と .exe
```
