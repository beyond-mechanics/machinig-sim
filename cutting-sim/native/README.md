# ネイティブ版（Rust コア＋デスクトップアプリ）

ブラウザ版の切削シミュレーターを、計算は Rust、画面はいまの HTML/Three.js のまま動かすための部分です。
研究用の試作で、結果は参考値です。

```
native/
  sph-core/        Rust の SPH コア（src/sph3d.js の 3D モードを移植、マルチスレッド）
    src/sim.rs       ソルバー本体（STL・3D 傾斜切削・3D エンドミル）
    src/tool2d.rs    刃先断面（tool.js のくさび・多角形）
    src/toolheat.rs  工具の温度格子（toolheat.js の接触熱と伝導。定常温度と摩耗は JS 側）
    src/meshsdf.rs   工具メッシュの符号付き距離場（src/mesh.js の MeshSDF）
    src/gpusim.rs, gpusim.wgsl  GPU 計算（wgpu、f32）。STL モードのステップ全体
    src/gpu.rs, gpu.wgsl  GPU ベンチ。対の 2 工程を GPU と CPU で計って比べる（sphgpu）
    src/engine.rs    画面とのやりとり（状態の受け取り、時間で区切った計算、バイナリのフレーム）
    src/bin/sphcli.rs    コマンドライン実行（状態ファイル → 力の履歴と要約）
    src/bin/sphserve.rs  ローカルサーバー（ページと計算を 127.0.0.1 で配る、試験用）
  app/src-tauri/   Tauri 2 のデスクトップアプリ（Windows では WebView2 の窓にページを出す）
  scripts/         JS との比較・計測・画面の確認
```

## しくみ

- 準備（ワークを粒子で埋める、支えの指定、工具の距離場の BVH）は今までどおり JS（Worker）で行い、その状態を
  JSON で Rust に渡します（src/nativestate.js）。準備のロジックが一か所にしかないので、JS 版と食い違いません。
- Rust は渡された状態から時間積分だけを受け持ちます。約 80 ms ずつ計算してはフレーム（全粒子の位置・温度・応力など、
  力の履歴）を返し、Worker がそれを自分の Cutting3D に書き戻して、今までと同じ表示・要約を作ります。
  画面側は src/native.js が Worker の代わりに立つだけで、他のコードは変わりません。
- アプリ（Tauri）では `window.__TAURI__`、ローカルサーバーでは `window.__SPH_NATIVE__` があるときだけ切り替わり、
  3D の計算（STL 取り込み、3D 傾斜切削、3D エンドミル）を Rust に回します。2D（直交切削・エンドミル断面）は 1 分以内に
  終わるので Worker のままです。
- 工具の温度格子は Rust で時間積分し、フレームごとに JS に返します。切削の終わりの定常温度と摩耗分布は JS が今までどおり計算します。

## JS と同じ答えになるか

並列化しても結果がスレッド数で変わらず、JS と丸め誤差の範囲で一致するように作っています。JS は粒子の対ごとに
両方の粒子へ足し込みます（scatter）が、Rust では各粒子が自分の対を JS と同じ順に集めます（gather）。足し算の順番が
同じなので、浮動小数点の結果も同じになります（違いは pow・exp・log の C ライブラリの最後の桁だけ）。

- ドリル例（38,592 粒子）を同じ状態から 1 ステップ: 全粒子の位置・密度・圧力・応力・温度がビット単位で一致、
  速度だけ 4 粒子が 1e-18 の差。
- 300 ステップ: 陽解法なので丸めの差は育ちますが、工具にかかる力は 1e-4 の相対差。
- 3D 傾斜切削（標準条件）: 2,500 ステップ後も切削抵抗の差は 2e-6。画面から最後まで計算して kc 2197 N/mm²、
  流出角 16.2°、工具温度 416 °C（JS 版の検証値 kc ≈ 2100、ηc ≈ 15.6°）。
- 3D エンドミル（2 刃続けて）: 1,500 ステップ後も全粒子がビット一致。画面の標準条件（7,700 粒子・23,603 ステップ）を
  最後まで計算して、JS 版と主分力 34.6 N・kc 1877 対 1879 N/mm²・流出角 46.5° が一致。

`node native/scripts/compare.mjs drill 2 native/sph-core/target/release/sphcli` が 2 ステップで一致を確かめます
（CI でも実行）。

## 速さ（ドリル例 φ1・38,592 粒子・120°・10,782 ステップ、4 コアの Xeon 2.8 GHz）

| | ms/ステップ | 全行程 |
|---|---|---|
| JS（ブラウザの Worker と同じ、1 スレッド） | 156 | 約 28 分 |
| Rust 1 スレッド | 171 | |
| Rust 4 スレッド | 46 | 約 8 分 |

1 スレッドでは JS とほぼ同じ速さです（各粒子が対を集める方式は、対ごとの計算を両側で 2 回するため）。そのかわり
コア数にほぼ比例して速くなります（4 スレッドで 3.7 倍）。8 コア 16 スレッドの PC なら JS の 6〜8 倍の見込みです。
画面から計算したときの全体の時間（4 コア、表示込み）は、3D エンドミル標準条件で JS 710 秒に対して 306 秒です。
粒子が 1 万個未満だと並列の効きが落ちる（4 スレッドで 2 倍強）ので、粒子を増やすほど差が開きます。
表示の更新は 1 秒に約 4 回にしています（毎回の書き戻しと描画が計算の CPU を食うため）。
STL 取り込みモードは、GPU があればそちらで計算します（下）。

## GPU 計算（STL 取り込みモード）

アプリでは、STL 取り込みモードの計算を GPU（wgpu、Windows では DirectX 12 か Vulkan）で行います。GPU が見つからない
ときや使えないときは、今までどおり CPU で計算します（環境変数 `SPH_GPU=0` でも CPU に戻せます）。画面の下の行に
「GPU 計算（GPU の名前、… ms/ステップ）」と出ます。3D 傾斜切削と 3D エンドミルは、まだ CPU です。

- ステップの全工程（速度勾配、Shepard フィルター、構成則と破壊、運動量、熱伝導、積分と工具接触）をシェーダーに
  移しました（`src/gpusim.wgsl`、`src/gpusim.rs`）。粒子は GPU に置いたままで、CPU は近傍探索（粒子がスキンの半分
  動いたとき、ドリル例で約 50 ステップに 1 回）とサンプル（1 回の計算で約 100 回）のときだけ粒子を読み戻します。
  ふだんのステップで読み戻すのは、力の合計と探索の要否の数十バイトだけです。
- 工具の距離場は、表面の近くのブリック（8³ セル）を最初に全部作って GPU に置きます。
- GPU は f32 で計算するので、CPU（f64）とはビット一致しません。ドリル例を最後まで計算して、推力 328 N
  （CPU 324 N、JS 324 N）、トルク 134 mNm（CPU・JS とも 134 mNm）、最後の 1/4 の最高温度の平均 685 °C（CPU 668 °C）。
  `node native/scripts/gpucheck.mjs <sphcli>` が 300 ステップで力の差を確かめます（CI でも実行、0.3% 程度）。
- `sphcli 状態.json --gpu` でコマンドラインからも GPU で計算できます（`--features gpu` でビルド）。

会社 PC（NVIDIA RTX PRO 2000）でのベンチでは、重い 2 工程が CPU 14 スレッドの 10〜11 倍でした（`sphgpu`、
成果物 `CuttingSim-gpu-bench`）。この開発環境には GPU がなく、CPU で GPU をまねる llvmpipe で正しさだけを確かめています。

## 作り方

```
cd cutting-sim
npm i && npm run build                  # dist/index.html
cargo build --release --manifest-path native/sph-core/Cargo.toml --features serve
```

- コマンドライン: `node native/scripts/dump.mjs drill state.json` で例の状態を書き、
  `native/sph-core/target/release/sphcli state.json --threads 4 --out result.json`。
- ローカルサーバー: `native/sph-core/target/release/sphserve dist/index.html 8765` を起動してブラウザで
  http://127.0.0.1:8765/ を開くと、3D の計算がサーバー側（Rust）で走ります。画面の下の行に
  「ネイティブ計算（n スレッド、… ms/ステップ）」と出ます。
- デスクトップアプリ（Windows）: GitHub Actions の「cutting-sim desktop」が windows-latest でビルドし、
  成果物 `CuttingSim-windows` に単体で動く `cutting-sim-app.exe` と、ユーザー単位のインストーラー（管理者権限なし）を置きます。
  手元でビルドするときは `node native/scripts/page.mjs` のあと `cd native/app && npx @tauri-apps/cli@2 build`。

## 会社 PC で使うときの注意

- Windows 10/11 に標準で入っている WebView2（Edge と同じエンジン）で画面を出します。別途ランタイムは要りません。
- Edge で WebGL が出なかった件の対策として、アプリの窓は `--ignore-gpu-blocklist` で起動します（GPU ドライバーが
  ブロックリストに載っているだけの場合に効きます）。ポリシーでハードウェアアクセラレーションが止められている場合は効かないので、
  そのときは今までどおり 2D キャンバスの簡易表示になります。
- 署名していない exe なので、SmartScreen の警告や社内のアプリ制限に掛かることがあります。配布前に情報システム部門に確認してください。

## 次の段階

1. GPU 計算を 3D 傾斜切削・3D エンドミルにも広げる（工具温度の格子の接触熱を GPU で）。近傍探索も GPU に移し、粒子数を 10 倍級に。
2. 高解像度向けの表示（フレームを f32 に、表示する粒子を間引く）、結果の VTK 書き出し（ParaView）、条件スイープの一括実行。
3. 2D（直交切削・エンドミル断面）の移植。今でも 1 分以内に終わるので後回しにしています。
