# 3軸加工シミュレーター

ブラウザで動く 3 軸フライス加工シミュレーター。Gコードを読み込み、材料除去・切削力 (側刃と底刃)・びびり振動・工具のたわみと応力・切削温度と工具摩耗・切粉の排出を計算して 3D 表示します。目標形状 (STL / STEP) を読み込むと、削り残しと削り過ぎを色で示します。

モデルの詳細と精度の限界は [DESIGN.md](DESIGN.md) を参照してください。

## 使い方

`dist/index.html` をブラウザで開くだけで動きます (Three.js を CDN から読み込むためネット接続が必要です)。ネットにつながらない環境では `dist/machining-sim-offline.html` を使ってください (STEP の読み込みだけは変換部品を CDN から取るので使えません)。

## できること

- **取り込み**: Gコード (ワーク座標系 G54〜G59・G54.1・G52、固定サイクル、工具径補正、サブプログラム M98/M99)、素材・目標形状・工具・ホルダーの STL / OBJ / STEP / IGES (単位・上方向・回転を指定)、Fusion の工具ライブラリ、実測 FRF。原点は数値でも 3D 画面のクリックでも指定できます
- **物理**: 刃のスライスごとの切削力 (ねじれ・振れ・寸法効果・プロセスダンピング)、再生びびりと多モードの動特性 (回転数による主軸の剛性低下、主軸・ホルダーのモード)、安定限界線図、薄肉壁 (抜き勾配付き) との連成、側面の面粗さ、切削温度と断続切削の温度変動、工具摩耗 (Usui 式)、切粉の排出とクーラント
- **切削係数**: 表の値のほか、材料定数 (Johnson–Cook) から Oxley 理論で予測、または切削試験の平均切削抵抗から同定
- **結果**: 振動・たわみ・寸法誤差 (指令/目標との差) の色分け、加工レポート (行ごとの集計、注意が必要な行と対策の目安、工具 1 本の加工個数、CSV)、工具経路の負荷色分け、送り最適化 (F を書き換えたプログラムの読み込み・保存)

## 開発

```sh
npm install
npm run build                 # src/ を dist/index.html に束ねる (node scripts/build.mjs)
npm test                      # test/*.test.mjs を全部実行して要約 (下の各テストを個別にも実行できる)
npm run smoke                 # ブラウザでの通し確認 (デモを最後まで計算し、主なパネルを開いてエラーが無いこと)
                              # Chromium の場所は PLAYWRIGHT_CHROMIUM で指定できる
node test/dyn.test.mjs        # 時間領域のびびり判定と安定限界線図の照合
node test/sim.test.mjs        # サンプルプログラムを通しで実行
node test/plunge.test.mjs     # 底刃 (プランジ・ランプ) のスラストとトルク
node test/thermal.test.mjs    # 切削温度と工具摩耗
node test/target.test.mjs     # 工具径補正と、指令どおりの形・目標形状 (STL) との寸法比較
node test/spindle.test.mjs    # 回転数で変わる工具先端の動特性と安定限界線図
node test/wcs.test.mjs        # ワーク座標系 (G54〜G59、G54.1、G52)
node test/subprog.test.mjs    # サブプログラム (M98 / M99)
node test/runout.test.mjs     # 工具の振れによる刃ごとの切りくずと側面の面粗さ
node test/report.test.mjs     # 加工レポート (行ごとの集計)
node test/seek.test.mjs       # 再生位置の移動
node test/oxley.test.mjs      # 材料定数 (Johnson–Cook) からの切削係数の予測
node test/identify.test.mjs   # 切削試験の平均切削抵抗からの係数の同定
node test/feedopt.test.mjs    # 送り最適化 (行ごとの送りと F の書き換え)
node test/advice.test.mjs     # 加工レポートの対策の目安
node test/cad.test.mjs        # STEP の読み込み (OpenCascade、npm install が必要)
node test/conditions.test.mjs # 推奨の切削条件 (はじめの目安)
node test/stabtd.test.mjs     # 時間領域の二分法による安定限界 (プロセスダンピング込み)
```

物理計算 (`src/gcode.js` `stock.js` `cutting.js` `sld.js` `tool.js` `thermal.js` `chips.js` `sim.js`) は DOM に依存しないので Node でそのまま動きます。表示は `view.js` `charts.js` `main.js` です。
