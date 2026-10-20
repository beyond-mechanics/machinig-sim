export const SAMPLES = {
  demo: {
    name: 'デモ: 段階スロットとポケット',
    code: `(STOCK 120 80 30)
(φ10 3枚刃 フラットエンドミル / A5052 を想定)
(1-3: 切込みを 0.5 → 1.0 → 2.0 mm と増やすスロット。びびりの発生を観察)
(4: 深さ 6 mm のポケット。切粉の溜まり方とエアブローの効果を観察)
G21 G90 G17
S12000 M3
G0 X-10 Y10 Z5
G0 Z-0.5
G1 X130 F1500
G0 Z5
G0 X-10 Y22
G0 Z-1.0
G1 X130 F1500
G0 Z5
G0 X-10 Y34
G0 Z-2.0
G1 X130 F1500
G0 Z5
(ポケット X20-100 Y46-74 深さ 6: 1 mm ずつ斜め進入して周回)
G0 X30 Y60
G0 Z1
G1 Z0 F600
G1 X90 Z-1 F1200
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G1 X30 Z-2
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G1 X30 Z-3
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G1 X30 Z-4
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G1 X30 Z-5
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G1 X30 Z-6
G1 X95 Y60
G1 Y51
G1 X25
G1 Y69
G1 X95
G1 Y60
G0 Z5
M5
M30
`,
  },
  contour: {
    name: '側面加工: ダウンカットとアップカット',
    code: `(STOCK 100 60 30)
(φ10 3枚刃 / 側面 ae=1.5 mm, ap=12 mm)
(1周目: 材料が進行方向右側 = ダウンカット / 2周目: 逆回り = アップカット)
G21 G90 G17
S14000 M3
G0 X-8 Y-3.5 Z5
G0 Z-12
(ダウンカット: 時計回りに外周を一周)
G1 X-3.5 Y-3.5 F1800
G1 Y63.5
G1 X103.5
G1 Y-3.5
G1 X-3.5
G0 X-10 Y-10
(アップカット: 反時計回りで 1.5 mm 内側を一周)
G1 X-2 Y-2 F1800
G1 X102
G1 Y62
G1 X-2
G1 Y-2
G0 Z5
M5
M30
`,
  },
  circle: {
    name: '円弧補間: ヘリカル穴あけ',
    code: `(STOCK 80 80 30)
(φ10 で φ30 の穴をヘリカル補間で深さ 8 mm まで加工)
G21 G90 G17
S10000 M3
G0 X50 Y40 Z3
G1 Z0 F800
G2 X50 Y40 I-10 J0 Z-1 F1000
G2 X50 Y40 I-10 J0 Z-2
G2 X50 Y40 I-10 J0 Z-3
G2 X50 Y40 I-10 J0 Z-4
G2 X50 Y40 I-10 J0 Z-5
G2 X50 Y40 I-10 J0 Z-6
G2 X50 Y40 I-10 J0 Z-7
G2 X50 Y40 I-10 J0 Z-8
G2 X50 Y40 I-10 J0
G1 X40
G0 Z5
M5
M30
`,
  },
  rib: {
    name: '薄肉リブ: ワークのたわみ',
    code: `(STOCK 100 60 25)
(薄肉リブ: 厚さ 6 mm まで荒取りしたあと、両側を全深さ 20 mm で仕上げて 2 mm にする)
(荒取り: 両側のスロットを 2 mm ずつ掘り下げる。22000 min⁻¹ は安定ポケット)
G21 G90 G17
S22000 M3
G0 X-8 Y38 Z5
G1 Z-2 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-4 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-6 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-8 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-10 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-12 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-14 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-16 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-18 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
G1 Z-20 F800
G1 X108 F3000
G1 Y22
G1 X-8
G1 Y38
(仕上げ: 23000 min⁻¹ で側面を仕上げる。どちらもダウンカット)
S23000
(1本目: 壁厚 6 → 4 mm を深さ 10 mm ずつ 2 段で)
G1 Y36 F800
G1 Z-10
G1 X108 F1200
G1 Z-20 F800
G1 X-8 F1200
G0 Z5
(2本目: 壁厚 4 → 2 mm を全深さ 20 mm で一気に仕上げる。高さ 20 mm の薄い壁を押すので大きく逃げる)
(1本目のように深さを分けると、押す位置が壁の根元に近いため逃げは小さい)
G0 X108 Y24
G1 Z-20 F800
G1 X-8 F1200
G0 Z5
M5
M30
`,
  },
  cam: {
    name: 'CAM 形式: 工具交換と穴あけ',
    code: `%
O2001 (CAM POST STYLE)
(STOCK 100 70 25)
(原点は素材上面の中心。原点の位置は自動で判定します)
(T1 D=10. CR=0. - ZMIN=-4. - flat end mill)
(T2 D=6. CR=3. - ZMIN=-4. - ball end mill)
(TOOL T3 D5 N2 DRILL L30 SO40)
N10 G90 G94 G17 G21
N20 G28 G91 Z0.
N30 G90
(ポケット 60 x 40 深さ 4: 斜め進入で 2 段)
N40 T1 M6
N50 S12000 M3
N60 G54 G0 X-25. Y0.
N70 G43 Z15. H1
N80 G0 Z2.
N90 G1 Z0. F600.
N100 G1 X25. Z-2. F1200.
N110 G1 Y7.5
N120 G1 X-25.
N130 G1 Y15.
N140 G1 X25.
N150 G1 Y-7.5
N160 G1 X-25.
N170 G1 Y-15.
N180 G1 X25.
N190 G1 Y0.
N200 G1 X-25. Z-4.
N210 G1 Y7.5
N220 G1 X25.
N230 G1 Y15.
N240 G1 X-25.
N250 G1 Y-7.5
N260 G1 X25.
N270 G1 Y-15.
N280 G1 X-25.
N290 G1 Y0.
N300 G1 X25.
N310 G0 Z15.
N320 G28 G91 Z0.
N330 G90
(ボールで XZ 平面の円弧溝: G18 G2 で中央が 3.8 mm 下がる)
N340 T2 M6
N350 S15000 M3
N360 G0 X-38. Y-28.
N370 G43 Z15. H2
N380 G0 Z1.
N390 G1 Z0. F500.
N400 G18 G2 X38. Z0. R190. F1000.
N410 G17 G0 Z15.
N420 G28 G91 Z0.
N430 G90
(ドリル φ5 の深穴: G83 で 3 mm ずつペック)
N440 T3 M6
N450 S3000 M3
N460 G0 X-44. Y-28.
N470 G43 Z15. H3
N480 G98 G83 X-44. Y-28. Z-12. R2. Q3. F150.
N490 X44.
N500 Y28.
N510 X-44.
N520 G80
N530 M5
N540 G28 G91 Z0.
N550 M30
%
`,
  },
  boss: {
    name: '工具径補正と目標形状: 角ボス',
    code: `(STOCK 60 60 15)
(TOOL T1 D10 N3 FLAT L25 SO30)
(30 × 30 の角ボスを高さ 5 mm で残す。輪郭は寸法そのままで書き、G42 で工具半径ずらす)
(目標形状 [仕上がり] はこのサンプルに組み込み済み。「目標との差」で削り残しと削り過ぎを色で見る)
(試しに 1 周目の G42 を消すと工具中心が輪郭に乗り、ボスの縁を幅 5 mm・深さ 2.5 mm 削り込む [赤])
(S10000 にすると 1 周目の全幅切削でびびり、ボスの側面を数十 µm 削り過ぎる)
G21 G90 G17
T1 M6
S14000 M3
G0 X-10 Y-10 Z5
G1 Z-2.5 F600
(1 周目: ボスの輪郭)
G42 D1 G1 X15 Y15 F900
X45
Y45
X15
Y15
G40 G1 X-10 Y-10
(2 周目と 3 周目: 外側の取り残しを 5 mm ずつ外へ)
G42 D1 G1 X10 Y10
X50
Y50
X10
Y10
G40 G1 X-10 Y-10
G42 D1 G1 X5 Y5
X55
Y55
X5
Y5
G40 G1 X-10 Y-10
G1 Z-5 F600
G42 D1 G1 X15 Y15 F900
X45
Y45
X15
Y15
G40 G1 X-10 Y-10
G42 D1 G1 X10 Y10
X50
Y50
X10
Y10
G40 G1 X-10 Y-10
G42 D1 G1 X5 Y5
X55
Y55
X5
Y5
G40 G1 X-10 Y-10
G0 Z5
M5
M30
`,
    // finished part as top-facing triangles: base at Z-5, boss 15〜45 to the top
    target: () => {
      const q = (x0, y0, x1, y1, z) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
      const tris = new Float32Array([...q(0, 0, 60, 60, -5), ...q(15, 15, 45, 45, 0)]);
      return { tris, count: tris.length / 9, min: [0, 0, -5], max: [60, 60, 0], name: '角ボス (組み込み)' };
    },
  },
};
