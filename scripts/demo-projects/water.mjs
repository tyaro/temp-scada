// 排水処理設備のデモ Project（架空の設備）。タグ名は
// apps/banto-scada/src/demo/scenarios/water.ts の筋書きと対応する。
import {
  Canvas,
  boolDisplay,
  definitionOnly,
  equipmentSymbol,
  idFactory,
  placeOnLine,
  screen,
} from "./lib.mjs";

const newId = idFactory("0199d301");
const BG = "#0b1220";
const MUTED = "#94a3b8";
const TEXT = "#e2e8f0";
const WATER = "#38bdf8";
const TREATED = "#2dd4bf";
const CHEMICAL = "#c084fc";
const AIR = "#cbd5e1";
const SLUDGE = "#b08968";
const TANK_FILL = "#0f1b2d";
const tag = (name) => `WWT.${name}`;

const screens = {
  overview: newId(),
  pumps: newId(),
  list: newId(),
  header: newId(),
  footer: newId(),
};

// --- 機器種別・Symbol・機器 -------------------------------------------------
const rotatingState = {
  source: "value",
  rows: [
    { match: 1, text: "運転", color: "#22c55e" },
    { match: 2, text: "故障", color: "#ef4444" },
  ],
  otherwise: { text: "停止", color: "#64748b" },
};
const types = {
  pump: {
    id: newId(),
    name: "ポンプ",
    slots: [
      {
        name: "state",
        type: "state",
        direction: "read",
        tagSuffix: ".State",
        stateDisplay: rotatingState,
      },
    ],
  },
  blower: {
    id: newId(),
    name: "ブロワー",
    slots: [
      {
        name: "state",
        type: "state",
        direction: "read",
        tagSuffix: ".State",
        stateDisplay: rotatingState,
      },
    ],
  },
  valve: {
    id: newId(),
    name: "バルブ",
    slots: [
      {
        name: "open",
        type: "bool",
        direction: "read",
        tagSuffix: ".Open",
        boolDisplay: {
          true: { text: "開", color: "#22c55e" },
          false: { text: "閉", color: "#64748b" },
        },
      },
    ],
  },
};
const symbols = {
  pump: equipmentSymbol(newId, "pump", {
    name: "ポンプ（状態つき）",
    slot: "state",
    slotType: "state",
  }),
  blower: equipmentSymbol(newId, "blower", {
    name: "ブロワー（状態つき）",
    slot: "state",
    slotType: "state",
  }),
  valve: equipmentSymbol(newId, "valve", {
    name: "バルブ（状態つき）",
    slot: "open",
    slotType: "bool",
    textSize: 26,
  }),
};
const equipment = {};
function machine(type, code, name, slot, tagName) {
  equipment[code] = {
    id: newId(),
    typeId: types[type].id,
    code,
    name,
    bindings: [{ slotName: slot, externalName: tag(tagName) }],
  };
}
machine("pump", "P-101", "原水ポンプ 1 号", "state", "P101.State");
machine("pump", "P-102", "原水ポンプ 2 号（予備）", "state", "P102.State");
machine("pump", "P-201", "薬注ポンプ", "state", "P201.State");
machine("pump", "P-501", "放流ポンプ", "state", "P501.State");
machine("blower", "B-301", "曝気ブロワー 1 号", "state", "B301.State");
machine("blower", "B-302", "曝気ブロワー 2 号", "state", "B302.State");
machine("valve", "V-101", "P-101 吐出弁", "open", "V101.Open");
machine("valve", "V-102", "P-102 吐出弁", "open", "V102.Open");
machine("valve", "V-401", "返送汚泥弁", "open", "V401.Open");

// --- 警報 -------------------------------------------------------------------
const alarms = {
  level: newId(),
  ph: newId(),
  oxygen: newId(),
  fault: newId(),
};
const alarmDefinitions = [
  {
    id: alarms.level,
    name: "T-101 原水槽 液位",
    enabled: true,
    source: {
      kind: "threshold",
      tag: tag("RawTank.Level"),
      limits: {
        hh: { value: 90, severity: "high", message: "原水槽 液位 異常高" },
        h: { value: 80, severity: "medium", message: "原水槽 液位 高" },
        l: { value: 20, severity: "low", message: "原水槽 液位 低" },
        ll: { value: 10, severity: "high", message: "原水槽 液位 異常低" },
      },
      deadband: 2,
    },
  },
  {
    id: alarms.ph,
    name: "T-201 pH",
    enabled: true,
    source: {
      kind: "threshold",
      tag: tag("React.pH"),
      limits: {
        h: { value: 8.5, severity: "medium", message: "pH 高" },
        l: { value: 5.8, severity: "medium", message: "pH 低" },
      },
      deadband: 0.1,
    },
  },
  {
    id: alarms.oxygen,
    name: "T-301 溶存酸素",
    enabled: true,
    source: {
      kind: "threshold",
      tag: tag("Aer.DO"),
      limits: { l: { value: 1.2, severity: "medium", message: "DO 低" } },
      deadband: 0.1,
    },
  },
  {
    id: alarms.fault,
    name: "P-102 故障",
    enabled: true,
    source: { kind: "bit", tag: tag("P102.Fault"), activeWhen: true },
    severity: "high",
    message: "原水ポンプ 2 号 故障",
  },
];

// --- トレンド ---------------------------------------------------------------
const trends = [
  {
    id: "trend:raw-level",
    name: "原水槽 液位・送水流量",
    historianNamespace: "demo",
    pens: [
      {
        id: "pen:level",
        seriesId: tag("RawTank.Level"),
        label: "原水槽 液位 %",
        color: "#38bdf8",
      },
      {
        id: "pen:feed",
        seriesId: tag("Feed.Flow"),
        label: "送水流量 m³/h",
        color: "#f59e0b",
      },
    ],
    windowMs: 600000,
    mode: "raw",
    maxPointsPerSeries: 600,
  },
  {
    id: "trend:quality",
    name: "pH・溶存酸素",
    historianNamespace: "demo",
    pens: [
      {
        id: "pen:ph",
        seriesId: tag("React.pH"),
        label: "pH",
        color: "#c084fc",
      },
      {
        id: "pen:do",
        seriesId: tag("Aer.DO"),
        label: "DO mg/L",
        color: "#2dd4bf",
      },
    ],
    windowMs: 600000,
    mode: "raw",
    maxPointsPerSeries: 600,
  },
  {
    id: "trend:pump-current",
    name: "原水ポンプ 電流・故障",
    historianNamespace: "demo",
    pens: [
      {
        id: "pen:p101",
        seriesId: tag("P101.Current"),
        label: "P-101 電流 A",
        color: "#22c55e",
      },
      {
        id: "pen:p102",
        seriesId: tag("P102.Current"),
        label: "P-102 電流 A",
        color: "#f59e0b",
      },
      {
        id: "pen:fault",
        seriesId: tag("P102.Fault"),
        label: "P-102 故障",
        color: "#ef4444",
      },
    ],
    windowMs: 600000,
    mode: "minmax",
    maxPointsPerSeries: 300,
  },
];

// --- 共通の部品 -------------------------------------------------------------
const FLOW = { decimals: 1, unit: "m³/h" };
const PERCENT = { decimals: 1, unit: "%" };
const flowing = (on = "送水中", off = "送水停止") =>
  boolDisplay(on, off, { onColor: WATER, offColor: "#475569" });

/** 槽（外形・液位・名前）。戻り値は外形の矩形。 */
function tank(canvas, x, y, width, height, label, levelTag, color = WATER) {
  canvas.text(x - 20, y - 28, width + 40, 22, label, {
    size: 15,
    weight: "bold",
    align: "center",
    color: TEXT,
  });
  canvas.rect(x, y, width, height, {
    name: `${label} 外形`,
    fill: TANK_FILL,
    stroke: MUTED,
    strokeWidth: 3,
  });
  canvas.level(x + 5, y + 5, width - 10, height - 10, tag(levelTag), {
    name: `${label} 液位`,
    color,
    background: TANK_FILL,
  });
}
/** 名前と値を横に並べる。 */
function reading(
  canvas,
  x,
  y,
  label,
  labelWidth,
  valueTag,
  valueWidth,
  format,
  size = 14,
) {
  canvas.text(x, y, labelWidth, size + 8, label, { size, color: MUTED });
  canvas.text(x + labelWidth, y, valueWidth, size + 8, "0", {
    size,
    weight: "bold",
    align: "right",
    color: TEXT,
    binding: tag(valueTag),
    format,
  });
}

// --- 全体フロー -------------------------------------------------------------
function overview() {
  const c = new Canvas(newId);
  c.text(30, 16, 600, 36, "排水処理設備　全体フロー", {
    size: 26,
    weight: "bold",
  });
  c.text(
    30,
    54,
    700,
    22,
    "架空の設備の模擬値です。機器を押すと読取の詳細を開けます。",
    {
      size: 14,
      color: MUTED,
    },
  );

  // 配色元（画面直下の bool 表示）。配管はこの文字の色に追従する。
  const feedState = c.text(404, 440, 110, 26, "送水", {
    name: "送水の状態",
    size: 16,
    weight: "bold",
    align: "center",
    binding: tag("Feed.Flowing"),
    boolDisplay: flowing(),
  });
  const run1 = c.text(0, 0, 10, 10, "P-101", {
    name: "P-101 吐出の配色元",
    visible: false,
    binding: tag("P101.Run"),
    boolDisplay: flowing(),
  });
  const run2 = c.text(0, 0, 10, 10, "P-102", {
    name: "P-102 吐出の配色元",
    visible: false,
    binding: tag("P102.Run"),
    boolDisplay: flowing(),
  });
  const dosing = c.text(0, 0, 10, 10, "P-201", {
    name: "薬注の配色元",
    visible: false,
    binding: tag("P201.Run"),
    boolDisplay: boolDisplay("注入中", "停止", {
      onColor: CHEMICAL,
      offColor: "#475569",
    }),
  });
  const assist = c.text(0, 0, 10, 10, "B-302", {
    name: "B-302 送気の配色元",
    visible: false,
    binding: tag("B302.Run"),
    boolDisplay: boolDisplay("送気中", "停止", {
      onColor: AIR,
      offColor: "#475569",
    }),
  });
  const returning = c.text(1124, 650, 78, 20, "返送", {
    name: "返送の状態",
    size: 13,
    weight: "bold",
    binding: tag("V401.Open"),
    boolDisplay: boolDisplay("返送中", "返送停止", {
      onColor: SLUDGE,
      offColor: "#475569",
    }),
  });
  const discharging = c.text(0, 0, 10, 10, "P-501", {
    name: "放流の配色元",
    visible: false,
    binding: tag("P501.Run"),
    boolDisplay: boolDisplay("放流中", "停止", {
      onColor: TREATED,
      offColor: "#475569",
    }),
  });

  // 流入と原水槽
  c.text(14, 282, 70, 20, "流入", { size: 14, color: MUTED });
  c.text(8, 300, 80, 20, "0", {
    size: 13,
    weight: "bold",
    binding: tag("Inflow.Flow"),
    format: FLOW,
  });
  c.pipe(
    [
      [14, 330],
      [90, 330],
    ],
    { arrow: "end", name: "流入" },
  );
  tank(c, 90, 280, 150, 320, "T-101 原水槽", "RawTank.Level");
  reading(c, 90, 608, "液位", 50, "RawTank.Level", 100, PERCENT);
  for (const [index, [limit, text]] of [
    ["hh", "HH"],
    ["h", "H"],
    ["l", "L"],
    ["ll", "LL"],
  ].entries())
    c.badge(246, 284 + index * 24, 40, 20, text, alarms.level, limit);

  // 原水ポンプ 2 台（吸込の分岐 → 吐出弁 → 合流）
  c.pipe(
    [
      [240, 530],
      [300, 530],
    ],
    { name: "P-102 吸込" },
  );
  c.pipe(
    [
      [270, 530],
      [270, 380],
      [300, 380],
    ],
    { name: "P-101 吸込（分岐）" },
  );
  const p101 = placeOnLine(c, symbols.pump, equipment["P-101"], 300, 380, 100);
  const p102 = placeOnLine(c, symbols.pump, equipment["P-102"], 300, 530, 100);
  const v101 = placeOnLine(c, symbols.valve, equipment["V-101"], 430, 380, 50);
  const v102 = placeOnLine(c, symbols.valve, equipment["V-102"], 430, 530, 50);
  c.pipe([p101.right, v101.left], { stateText: run1, name: "P-101 吐出" });
  c.pipe([v101.right, [520, 380], [520, 455]], {
    stateText: run1,
    name: "P-101 吐出（合流へ）",
  });
  c.pipe([p102.right, v102.left], { stateText: run2, name: "P-102 吐出" });
  c.pipe([v102.right, [520, 530], [520, 455]], {
    stateText: run2,
    name: "P-102 吐出（合流へ）",
  });
  c.pipe(
    [
      [520, 455],
      [610, 455],
    ],
    { arrow: "end", stateText: feedState, name: "送水（合流後）" },
  );
  c.badge(408, 576, 56, 20, "故障", alarms.fault);
  c.text(528, 396, 80, 18, "FIT-101", { size: 12, color: MUTED });
  c.text(524, 414, 84, 20, "0", {
    size: 13,
    weight: "bold",
    binding: tag("Feed.Flow"),
    format: FLOW,
  });
  c.text(528, 466, 80, 18, "PIT-101", { size: 12, color: MUTED });
  c.text(524, 484, 84, 20, "0", {
    size: 13,
    weight: "bold",
    binding: tag("Feed.Pressure"),
    format: { decimals: 2, unit: "MPa" },
  });
  c.nav(296, 618, 190, 32, "原水ポンプ場の詳細 ▶", {
    kind: "screen",
    screenId: screens.pumps,
  });

  // pH 調整槽と薬注
  tank(c, 610, 330, 150, 270, "T-201 pH 調整槽", "React.Level", "#60a5fa");
  reading(c, 610, 606, "pH", 30, "React.pH", 50, { decimals: 2 });
  c.badge(700, 606, 28, 20, "H", alarms.ph, "h");
  c.badge(732, 606, 28, 20, "L", alarms.ph, "l");
  c.text(520, 102, 140, 22, "T-202 薬品", {
    size: 14,
    weight: "bold",
    align: "center",
  });
  c.rect(560, 128, 60, 110, {
    name: "T-202 外形",
    fill: TANK_FILL,
    stroke: MUTED,
    strokeWidth: 2,
  });
  c.level(564, 132, 52, 102, tag("Chem.Level"), {
    name: "T-202 液位",
    color: CHEMICAL,
    background: TANK_FILL,
  });
  c.pipe(
    [
      [620, 215],
      [650, 215],
    ],
    { color: CHEMICAL, width: 4, lineStyle: "dashed", name: "薬品 吸込" },
  );
  const p201 = placeOnLine(c, symbols.pump, equipment["P-201"], 650, 215, 70);
  c.pipe([p201.right, [752, 215], [752, 330]], {
    color: CHEMICAL,
    width: 4,
    lineStyle: "dashed",
    arrow: "end",
    stateText: dosing,
    name: "薬品 注入",
  });

  // 曝気槽とブロワー
  c.pipe(
    [
      [760, 455],
      [850, 455],
    ],
    { arrow: "end", name: "pH 調整槽 → 曝気槽" },
  );
  tank(c, 850, 330, 220, 270, "T-301 曝気槽", "Aer.Level", "#60a5fa");
  c.text(1080, 340, 30, 20, "DO", { size: 13, color: MUTED });
  c.text(1076, 358, 62, 20, "0", {
    size: 13,
    weight: "bold",
    binding: tag("Aer.DO"),
    format: { decimals: 2 },
  });
  c.text(1080, 376, 50, 18, "mg/L", { size: 12, color: MUTED });
  c.badge(1080, 398, 28, 20, "L", alarms.oxygen, "l");
  const b301 = placeOnLine(c, symbols.blower, equipment["B-301"], 640, 690, 80);
  const b302 = placeOnLine(c, symbols.blower, equipment["B-302"], 640, 820, 80);
  c.pipe([b301.right, [780, 690]], {
    color: AIR,
    width: 4,
    name: "B-301 送気",
  });
  c.pipe([b302.right, [780, 820], [780, 690]], {
    color: AIR,
    width: 4,
    stateText: assist,
    name: "B-302 送気",
  });
  c.pipe(
    [
      [780, 690],
      [1030, 690],
      [1030, 600],
    ],
    { color: AIR, width: 4, arrow: "end", name: "空気 母管" },
  );
  c.pipe(
    [
      [890, 690],
      [890, 600],
    ],
    { color: AIR, width: 4, arrow: "end", name: "散気 1" },
  );
  c.pipe(
    [
      [960, 690],
      [960, 600],
    ],
    { color: AIR, width: 4, arrow: "end", name: "散気 2" },
  );
  reading(
    c,
    800,
    700,
    "風量",
    40,
    "Air.Flow",
    110,
    { decimals: 1, unit: "m³/min" },
    13,
  );

  // 沈殿槽と返送汚泥（空気の立ち上がりをまたぐ）
  c.pipe(
    [
      [1070, 455],
      [1140, 455],
    ],
    { arrow: "end", name: "曝気槽 → 沈殿槽" },
  );
  tank(c, 1140, 330, 160, 270, "T-401 沈殿槽", "Clar.Level", "#60a5fa");
  reading(
    c,
    1232,
    608,
    "汚泥界面",
    60,
    "Clar.Sludge",
    60,
    { decimals: 2, unit: "m" },
    13,
  );
  const v401 = placeOnLine(c, symbols.valve, equipment["V-401"], 1060, 645, 50);
  c.pipe([[1220, 600], [1220, 645], v401.right], {
    color: SLUDGE,
    width: 5,
    name: "汚泥 引抜",
  });
  c.pipe([v401.left, [805, 645], [805, 455]], {
    color: SLUDGE,
    width: 5,
    arrow: "end",
    stateText: returning,
    name: "返送汚泥",
  });
  c.text(1124, 670, 78, 18, "0", {
    size: 12,
    binding: tag("Return.Flow"),
    format: FLOW,
    color: MUTED,
  });

  // 処理水槽と放流
  c.pipe(
    [
      [1300, 455],
      [1370, 455],
    ],
    { color: TREATED, arrow: "end", name: "沈殿槽 → 処理水槽" },
  );
  tank(c, 1370, 360, 140, 240, "T-501 処理水槽", "Treated.Level", TREATED);
  reading(
    c,
    1452,
    608,
    "濁度",
    40,
    "Treated.Turbidity",
    90,
    { decimals: 2, unit: "NTU" },
    13,
  );
  c.pipe(
    [
      [1440, 600],
      [1440, 740],
      [1460, 740],
    ],
    { color: TREATED, name: "放流ポンプ 吸込" },
  );
  const p501 = placeOnLine(c, symbols.pump, equipment["P-501"], 1460, 740, 80);
  c.pipe([p501.right, [1590, 740]], {
    color: TREATED,
    arrow: "end",
    stateText: discharging,
    name: "放流",
  });
  c.text(1540, 752, 56, 18, "放流", {
    size: 13,
    color: MUTED,
    align: "center",
  });
  reading(c, 1452, 816, "FIT-501", 56, "Out.Flow", 84, FLOW, 13);

  // 主要計測の表
  c.table(1090, 716, 330, 160, {
    name: "主要計測",
    columns: [5, 4],
    size: 14,
    background: "#0f172a",
    cells: [
      [
        { text: "主要計測", fill: "#1e293b" },
        { text: "現在値", fill: "#1e293b" },
      ],
      [
        "流入量",
        {
          text: "0",
          binding: { externalName: tag("Inflow.Flow") },
          format: FLOW,
        },
      ],
      [
        "送水量",
        {
          text: "0",
          binding: { externalName: tag("Feed.Flow") },
          format: FLOW,
        },
      ],
      [
        "積算送水量",
        {
          text: "0",
          binding: { externalName: tag("Feed.Total") },
          format: { decimals: 0, unit: "m³" },
        },
      ],
      [
        "放流量",
        { text: "0", binding: { externalName: tag("Out.Flow") }, format: FLOW },
      ],
    ],
  });

  // トレンドと凡例
  c.trend(40, 690, 280, 104, trends[0].id);
  c.trend(330, 690, 280, 104, trends[1].id);
  c.text(40, 812, 60, 20, "状態色", { size: 13, color: MUTED });
  for (const [index, [color, label]] of [
    ["#22c55e", "運転・開"],
    ["#64748b", "停止・閉"],
    ["#ef4444", "故障"],
    ["#d97706", "取得不能"],
  ].entries()) {
    c.rect(40 + index * 140, 840, 18, 18, {
      fill: color,
      name: `凡例 ${label}`,
    });
    c.text(64 + index * 140, 838, 110, 22, label, { size: 14 });
  }
  return screen(screens.overview, "全体フロー", 1600, 900, BG, c, {
    lineHops: "arc",
  });
}

// --- 原水ポンプ場 -----------------------------------------------------------
function pumpStation() {
  const c = new Canvas(newId);
  c.text(30, 16, 600, 36, "原水ポンプ場", { size: 26, weight: "bold" });
  c.text(
    30,
    54,
    700,
    22,
    "液位の警報の小札は、しきい値の高さに置いています。",
    {
      size: 14,
      color: MUTED,
    },
  );
  const feedState = c.text(1000, 432, 130, 30, "送水", {
    name: "送水の状態",
    size: 18,
    weight: "bold",
    binding: tag("Feed.Flowing"),
    boolDisplay: flowing(),
  });
  const run1 = c.text(0, 0, 10, 10, "P-101", {
    name: "P-101 吐出の配色元",
    visible: false,
    binding: tag("P101.Run"),
    boolDisplay: flowing(),
  });
  const run2 = c.text(0, 0, 10, 10, "P-102", {
    name: "P-102 吐出の配色元",
    visible: false,
    binding: tag("P102.Run"),
    boolDisplay: flowing(),
  });

  // 原水槽（大）
  c.pipe(
    [
      [300, 96],
      [300, 180],
    ],
    { arrow: "end", name: "流入" },
  );
  reading(c, 316, 104, "流入", 40, "Inflow.Flow", 100, FLOW);
  c.text(120, 130, 170, 44, "0", {
    name: "原水槽 液位（大）",
    size: 32,
    weight: "bold",
    align: "right",
    binding: tag("RawTank.Level"),
    format: PERCENT,
  });
  c.rect(150, 180, 300, 520, {
    name: "T-101 外形",
    fill: TANK_FILL,
    stroke: MUTED,
    strokeWidth: 3,
  });
  c.level(156, 186, 288, 508, tag("RawTank.Level"), {
    name: "T-101 液位",
    background: TANK_FILL,
  });
  c.text(150, 706, 300, 24, "T-101 原水槽", {
    size: 16,
    weight: "bold",
    align: "center",
  });
  for (const [limit, text, percent, color] of [
    ["hh", "HH", 90, "#ef4444"],
    ["h", "H", 80, "#f59e0b"],
    ["l", "L", 20, "#f59e0b"],
    ["ll", "LL", 10, "#ef4444"],
  ]) {
    const y = 694 - (508 * percent) / 100;
    c.pipe(
      [
        [156, y],
        [444, y],
      ],
      { color, width: 2, lineStyle: "dashed", name: `しきい値 ${text}` },
    );
    c.badge(98, y - 11, 44, 22, text, alarms.level, limit, { size: 13 });
    c.text(40, y - 10, 52, 20, `${percent} %`, {
      size: 13,
      color: MUTED,
      align: "right",
    });
  }

  // ポンプ 2 台
  c.pipe(
    [
      [450, 640],
      [560, 640],
    ],
    { name: "P-102 吸込" },
  );
  c.pipe(
    [
      [505, 640],
      [505, 330],
      [560, 330],
    ],
    { name: "P-101 吸込（分岐）" },
  );
  const p101 = placeOnLine(c, symbols.pump, equipment["P-101"], 560, 330, 180);
  const p102 = placeOnLine(c, symbols.pump, equipment["P-102"], 560, 640, 180);
  const v101 = placeOnLine(c, symbols.valve, equipment["V-101"], 800, 330, 90);
  const v102 = placeOnLine(c, symbols.valve, equipment["V-102"], 800, 640, 90);
  c.pipe([p101.right, v101.left], {
    width: 8,
    stateText: run1,
    name: "P-101 吐出",
  });
  c.pipe([v101.right, [980, 330], [980, 485]], {
    width: 8,
    stateText: run1,
    name: "P-101 吐出（合流へ）",
  });
  c.pipe([p102.right, v102.left], {
    width: 8,
    stateText: run2,
    name: "P-102 吐出",
  });
  c.pipe([v102.right, [980, 640], [980, 485]], {
    width: 8,
    stateText: run2,
    name: "P-102 吐出（合流へ）",
  });
  c.pipe(
    [
      [980, 485],
      [1120, 485],
    ],
    { width: 8, arrow: "end", stateText: feedState, name: "送水（合流後）" },
  );
  c.text(1000, 500, 130, 20, "pH 調整槽へ", { size: 13, color: MUTED });
  reading(c, 760, 404, "電流", 40, "P101.Current", 80, {
    decimals: 1,
    unit: "A",
  });
  reading(c, 760, 714, "電流", 40, "P102.Current", 80, {
    decimals: 1,
    unit: "A",
  });
  c.badge(760, 744, 70, 24, "故障", alarms.fault, undefined, { size: 14 });
  reading(c, 1000, 530, "FIT-101", 64, "Feed.Flow", 96, FLOW);
  reading(c, 1000, 556, "PIT-101", 64, "Feed.Pressure", 96, {
    decimals: 3,
    unit: "MPa",
  });

  // 表・トレンド・筋書きの説明
  c.table(1180, 110, 390, 132, {
    name: "ポンプの運転データ",
    columns: [3, 3, 4],
    size: 15,
    background: "#0f172a",
    cells: [
      [
        { text: "機器", fill: "#1e293b" },
        { text: "電流", fill: "#1e293b" },
        { text: "運転時間", fill: "#1e293b" },
      ],
      [
        "P-101",
        {
          text: "0",
          binding: { externalName: tag("P101.Current") },
          format: { decimals: 1, unit: "A" },
        },
        {
          text: "0",
          binding: { externalName: tag("P101.Hours") },
          format: { decimals: 1, unit: "h" },
        },
      ],
      [
        "P-102",
        {
          text: "0",
          binding: { externalName: tag("P102.Current") },
          format: { decimals: 1, unit: "A" },
        },
        {
          text: "0",
          binding: { externalName: tag("P102.Hours") },
          format: { decimals: 1, unit: "h" },
        },
      ],
    ],
  });
  reading(
    c,
    1180,
    256,
    "積算送水量",
    90,
    "Feed.Total",
    140,
    { decimals: 0, unit: "m³" },
    15,
  );
  c.trend(1180, 300, 390, 104, trends[0].id);
  c.trend(1180, 416, 390, 104, trends[2].id);
  c.rect(1180, 540, 390, 170, {
    name: "筋書きの枠",
    fill: "#0f172a",
    stroke: "#334155",
    strokeWidth: 1,
  });
  c.text(1194, 550, 362, 24, "模擬値の筋書き（3 分で一巡）", {
    size: 15,
    weight: "bold",
  });
  c.text(
    1194,
    582,
    362,
    118,
    "① 流入が増え、原水槽の液位が上がる\n② 80 % を超える頃に P-102 が起動し、H・HH の警報\n③ 2 台で送水して液位が下がる\n④ P-102 が故障（警報）、後に復帰\n⑤ 20 % を下回り L の警報、P-101 が停止\n⑥ 送水を再開して最初へ戻る",
    { size: 14, color: MUTED, wrap: "word" },
  );
  c.nav(1380, 824, 190, 40, "◀ 全体フローへ", {
    kind: "screen",
    screenId: screens.overview,
  });
  return screen(screens.pumps, "原水ポンプ場", 1600, 900, BG, c);
}

// --- 計測一覧 ---------------------------------------------------------------
function measurementList() {
  const c = new Canvas(newId);
  c.text(30, 16, 600, 36, "計測一覧", { size: 26, weight: "bold" });
  c.text(
    30,
    54,
    700,
    22,
    "表のセルと横向きの液位で、同じタグを別の形で表しています。",
    {
      size: 14,
      color: MUTED,
    },
  );
  const head = (text) => ({ text, fill: "#1e293b" });
  const row = (code, name, valueTag, format) => [
    code,
    name,
    { text: "0", binding: { externalName: tag(valueTag) }, format },
  ];
  c.table(40, 100, 760, 720, {
    name: "計測値の表",
    columns: [2, 4, 3],
    size: 15,
    background: "#0f172a",
    cells: [
      [head("計器"), head("名称"), head("現在値")],
      row("FIT-001", "流入量", "Inflow.Flow", FLOW),
      row("LIT-101", "原水槽 液位", "RawTank.Level", PERCENT),
      row("FIT-101", "送水流量", "Feed.Flow", FLOW),
      row("PIT-101", "送水圧力", "Feed.Pressure", { decimals: 3, unit: "MPa" }),
      row("FQ-101", "積算送水量", "Feed.Total", { decimals: 0, unit: "m³" }),
      row("LIT-202", "薬品タンク 液位", "Chem.Level", PERCENT),
      row("AIT-201", "pH 調整槽 pH", "React.pH", { decimals: 2 }),
      row("AIT-301", "曝気槽 溶存酸素", "Aer.DO", {
        decimals: 2,
        unit: "mg/L",
      }),
      row("FIT-301", "曝気 風量", "Air.Flow", { decimals: 1, unit: "m³/min" }),
      row("LIT-401", "沈殿槽 汚泥界面", "Clar.Sludge", {
        decimals: 2,
        unit: "m",
      }),
      row("FIT-401", "返送汚泥量", "Return.Flow", FLOW),
      row("AIT-501", "処理水 濁度", "Treated.Turbidity", {
        decimals: 2,
        unit: "NTU",
      }),
      row("FIT-501", "放流量", "Out.Flow", FLOW),
    ],
  });

  c.text(860, 100, 400, 24, "槽の液位", { size: 17, weight: "bold" });
  for (const [index, [label, levelTag, color]] of [
    ["T-101 原水槽", "RawTank.Level", WATER],
    ["T-201 pH 調整槽", "React.Level", "#60a5fa"],
    ["T-202 薬品", "Chem.Level", CHEMICAL],
    ["T-301 曝気槽", "Aer.Level", "#60a5fa"],
    ["T-401 沈殿槽", "Clar.Level", "#60a5fa"],
    ["T-501 処理水槽", "Treated.Level", TREATED],
  ].entries()) {
    const y = 140 + index * 58;
    c.text(860, y, 160, 26, label, { size: 15 });
    c.rect(1028, y, 404, 26, {
      name: `${label} 枠`,
      fill: TANK_FILL,
      stroke: "#475569",
      strokeWidth: 1,
    });
    c.level(1030, y + 2, 400, 22, tag(levelTag), {
      name: `${label} 液位（横）`,
      color,
      background: TANK_FILL,
      direction: "right",
    });
    c.text(1440, y, 110, 26, "0", {
      size: 15,
      weight: "bold",
      align: "right",
      binding: tag(levelTag),
      format: PERCENT,
    });
  }

  c.text(860, 510, 400, 24, "機器の状態（bit のタグを文字と色に）", {
    size: 17,
    weight: "bold",
  });
  const state = (on, off) => boolDisplay(on, off);
  for (const [index, [label, stateTag, display]] of [
    ["P-101 原水ポンプ 1 号", "P101.Run", state("運転", "停止")],
    ["P-102 原水ポンプ 2 号", "P102.Run", state("運転", "停止")],
    [
      "P-102 故障",
      "P102.Fault",
      boolDisplay("故障", "正常", { onColor: "#ef4444", offColor: "#22c55e" }),
    ],
    ["P-201 薬注ポンプ", "P201.Run", state("運転", "停止")],
    ["B-301 曝気ブロワー 1 号", "B301.Run", state("運転", "停止")],
    ["B-302 曝気ブロワー 2 号", "B302.Run", state("運転", "停止")],
    ["V-401 返送汚泥弁", "V401.Open", state("開", "閉")],
    ["P-501 放流ポンプ", "P501.Run", state("運転", "停止")],
  ].entries()) {
    const x = 860 + (index % 2) * 360,
      y = 548 + Math.floor(index / 2) * 44;
    const stateText = c.text(x + 232, y, 90, 30, "状態", {
      name: `${label} の状態`,
      size: 17,
      weight: "bold",
      align: "center",
      binding: tag(stateTag),
      boolDisplay: display,
    });
    c.rect(x, y + 5, 20, 20, {
      name: `${label} の灯`,
      fill: "#64748b",
      stateText,
    });
    c.text(x + 30, y + 2, 200, 26, label, { size: 15 });
  }
  c.nav(1380, 824, 190, 40, "◀ 全体フローへ", {
    kind: "screen",
    screenId: screens.overview,
  });
  return screen(screens.list, "計測一覧", 1600, 900, BG, c);
}

// --- 運転表示の枠 -----------------------------------------------------------
function header() {
  const c = new Canvas(newId);
  c.text(16, 10, 190, 34, "排水処理設備", { size: 20, weight: "bold" });
  c.nav(214, 10, 130, 34, "全体フロー", {
    kind: "screen",
    screenId: screens.overview,
  });
  c.nav(352, 10, 140, 34, "原水ポンプ場", {
    kind: "screen",
    screenId: screens.pumps,
  });
  c.nav(500, 10, 120, 34, "計測一覧", {
    kind: "screen",
    screenId: screens.list,
  });
  c.nav(650, 10, 80, 34, "◀ 戻る", { kind: "back" });
  c.nav(738, 10, 80, 34, "進む ▶", { kind: "forward" });
  c.nav(
    848,
    10,
    140,
    34,
    "アラーム一覧",
    { kind: "alarmList" },
    { fill: "#3f1d1d", textColor: "#fecaca" },
  );
  c.clock(1320, 12, 264, 30, { size: 18, align: "right" });
  c.banner(16, 54, 1568, 30, { size: 15 });
  return screen(screens.header, "運転表示ヘッダー", 1600, 94, "#0f172a", c);
}
function footer() {
  const c = new Canvas(newId);
  c.text(
    16,
    5,
    1568,
    20,
    "デモ（模擬値）— 架空の排水処理設備です。実設備・Hub・PLC には接続していません。",
    {
      size: 13,
      color: MUTED,
    },
  );
  return screen(screens.footer, "運転表示フッター", 1600, 30, "#0f172a", c);
}

export function waterProject() {
  return {
    operatorFrame: {
      startScreenId: screens.overview,
      headerScreenId: screens.header,
      footerScreenId: screens.footer,
    },
    alarms: { definitions: alarmDefinitions },
    trends,
    equipmentTypes: Object.values(types),
    equipment: Object.values(equipment),
    assets: [],
    manifest: {
      product: "banto-scada",
      schemaVersion: "0.37.0",
      projectId: newId(),
      projectRevision: 1,
      minRuntimeVersion: "0.37.0",
      name: "デモ 排水処理設備（模擬値）",
    },
    screens: [overview(), pumpStation(), measurementList(), header(), footer()],
    symbols: Object.values(symbols).map(definitionOnly),
  };
}
