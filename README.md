# 3軸加工シミュレーター

ブラウザで動く 3 軸フライス加工シミュレーター。Gコードを読み込み、材料除去・切削力 (側刃と底刃)・びびり振動・工具のたわみと応力・切削温度と工具摩耗・切粉の排出を計算して 3D 表示します。目標形状 (STL) を読み込むと、削り残しと削り過ぎを色で示します。

モデルの詳細と精度の限界は [DESIGN.md](DESIGN.md) を参照してください。

## 使い方

`dist/index.html` をブラウザで開くだけで動きます (Three.js を CDN から読み込むためネット接続が必要です)。

## 開発

```sh
npm install
node scripts/build.mjs        # src/ を dist/index.html に束ねる
node test/dyn.test.mjs        # 時間領域のびびり判定と安定限界線図の照合
node test/sim.test.mjs        # サンプルプログラムを通しで実行
node test/plunge.test.mjs     # 底刃 (プランジ・ランプ) のスラストとトルク
node test/thermal.test.mjs    # 切削温度と工具摩耗
node test/target.test.mjs     # 工具径補正と、指令どおりの形・目標形状 (STL) との寸法比較
node test/spindle.test.mjs    # 回転数で変わる工具先端の動特性と安定限界線図
node test/wcs.test.mjs        # ワーク座標系 (G54〜G59、G54.1、G52)
node test/runout.test.mjs     # 工具の振れによる刃ごとの切りくずと側面の面粗さ
```

物理計算 (`src/gcode.js` `stock.js` `cutting.js` `sld.js` `tool.js` `thermal.js` `chips.js` `sim.js`) は DOM に依存しないので Node でそのまま動きます。表示は `view.js` `charts.js` `main.js` です。
