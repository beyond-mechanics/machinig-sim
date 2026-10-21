# 3軸加工シミュレーター

ブラウザで動く 3 軸フライス加工シミュレーター。Gコードを読み込み、材料除去・切削力 (側刃と底刃)・びびり振動・工具のたわみと応力・切削温度と工具摩耗・切粉の排出を計算して 3D 表示します。目標形状 (STL) を読み込むと、削り残しと削り過ぎを色で示します。

モデルの詳細と精度の限界は [DESIGN.md](DESIGN.md) を参照してください。

## 使い方

`dist/index.html` をブラウザで開くだけで動きます (Three.js を CDN から読み込むためネット接続が必要です)。

切削係数は材料ごとの文献並みの値です。[切削現象シミュレーター](cutting-sim/) のエンドミルモードで同定して書き出した係数 JSON を「加工条件 › 被削材 › 切削シミュの係数」で読み込むと、対応する材料に切り替えてその Ktc・Krc・Kte・Kre（ねじれ刃モードなら Kac・Kae も）で計算します。寸法効果の指数 mc は表の値のままです。

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
node test/coeffs.test.mjs     # 切削シミュの係数ファイルの読み込み
```

物理計算 (`src/gcode.js` `stock.js` `cutting.js` `sld.js` `tool.js` `thermal.js` `chips.js` `sim.js`) は DOM に依存しないので Node でそのまま動きます。表示は `view.js` `charts.js` `main.js` です。
