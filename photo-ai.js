// ===== 写真から食事を判定する・栄養成分表示を読み取る（Claude API） =====
//
// 食事の写真を Claude に送り、写っている料理ごとの量の見積もりと kcal / P / F / C を JSON で受け取る。
// 商品の栄養成分表示の写真からは、書いてある数字をそのまま読み取る。
// サーバーを持たないアプリなので、ブラウザから直接 API を呼ぶ（SDK の dangerouslyAllowBrowser）。
// API キーは本人がこの端末に入れたもので、この端末の localStorage にだけ置く（同期・書き出しには含めない）。
//
// SDK は使うときに初めて読み込む。オフラインや読み込み失敗でも、アプリ本体には影響させない。
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
export const MODEL = "claude-opus-5-5";
// 料金の目安（Claude Opus 5.5：入力 $4 / 出力 $20、100万トークンあたり）。画面に「今回 約○円」を出すためだけに使う
const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6, YEN_PER_USD = 150;

const SYSTEM = `あなたは日本の管理栄養士です。食事の写真から、写っている料理・食品ごとに量を見積もり、エネルギーとPFCを推定します。

- 料理は日本語で、ふだん呼ぶ名前にする（例：ご飯、豚の生姜焼き、キャベツの千切り、味噌汁）。盛り合わせは、栄養が大きく違うものは分ける
- 量は皿・茶碗・箸などの大きさから見積もり、amount に「茶碗1杯 約150g」「4個 約100g」のように書く
- 値は日本食品標準成分表（八訂）を基準にし、調理に使った油・衣・ソース・ドレッシングの分も、見えていなくても一般的な作り方で含める
- kcal / p / f / c は、その料理の見積もった量の合計（1人分の写っている量）。p・f・c はグラム
- confidence は量と中身の見積もりの確からしさ（high / medium / low）。中身が見えない・量が分かりにくいものは low
- note には、推定が大きくずれそうな点（見えない油、ソースの量、食べ残しが不明など）を短く書く。特になければ空文字
- 食べ物が写っていない写真では items を空にし、note にその旨を書く
- ユーザーのメモがあれば優先して反映する（例：「ご飯は半分残した」）`;

// 返してほしい形。Structured outputs で、この形の JSON だけが返ってくる
const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          amount: { type: "string" },
          kcal: { type: "number" },
          p: { type: "number" },
          f: { type: "number" },
          c: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["name", "amount", "kcal", "p", "f", "c", "confidence"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["items", "note"],
  additionalProperties: false,
};

// 栄養成分表示の読み取り。見積もりではなく、書いてある数字を写すだけ
const LABEL_SYSTEM = `あなたは日本の食品の「栄養成分表示」を読み取る係です。写真に写っている表示の数字を、そのまま写します。

- 推測や計算で値を作らない。読めない数字は 0 にして、note にその旨を書く
- basis には表示の基準を、書いてあるとおり短く写す（例：「1袋（52g）あたり」「100gあたり」「1本（500ml）あたり」）
- kcal は「エネルギー」、p は「たんぱく質」、f は「脂質」、c は「炭水化物」（g）。炭水化物が無く「糖質」と「食物繊維」が分かれていれば、その合計を c にする
- name には商品名が写っていれば短く書く（例：「サラダチキン プレーン」）。写っていなければ空文字
- 栄養成分表示が写っていない写真では found を false にする
- note には、気をつける点（「100gあたりの表示。内容量は 220g」など）を短く書く。特になければ空文字`;
const LABEL_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    name: { type: "string" },
    basis: { type: "string" },
    kcal: { type: "number" },
    p: { type: "number" },
    f: { type: "number" },
    c: { type: "number" },
    note: { type: "string" },
  },
  required: ["found", "name", "basis", "kcal", "p", "f", "c", "note"],
  additionalProperties: false,
};

let sdk = null;
async function loadSdk() {
  if (!sdk) sdk = await import(SDK_URL);
  return sdk;
}

// 画面に出す日本語のエラー
export class PhotoAIError extends Error {}

/**
 * 写真を判定する。
 * @param {{apiKey: string, effort: "low"|"medium", imageBase64: string, mediaType: string, memo?: string}} opts
 * @returns {Promise<{items: Array, note: string, yen: number, usage: object}>}
 */
export async function analyzeMealPhoto({ apiKey, effort, imageBase64, mediaType, memo }) {
  const { data, yen, usage } = await askWithImage({
    apiKey, effort, system: SYSTEM, schema: SCHEMA, imageBase64, mediaType,
    text: memo ? `この食事を判定してください。メモ：${memo}` : "この食事を判定してください。",
  });
  return { items: data.items || [], note: data.note || "", yen, usage };
}

/**
 * 栄養成分表示を読み取る。数字を写すだけなので、深さはいつも low
 * @returns {Promise<{found: boolean, name: string, basis: string, kcal: number, p: number, f: number, c: number, note: string, yen: number}>}
 */
export async function readNutritionLabel({ apiKey, imageBase64, mediaType }) {
  const { data, yen } = await askWithImage({
    apiKey, effort: "low", system: LABEL_SYSTEM, schema: LABEL_SCHEMA, imageBase64, mediaType,
    text: "この栄養成分表示を読み取ってください。",
  });
  return { ...data, yen };
}

// 写真1枚と指示を送り、スキーマの形の JSON を受け取る（判定・読み取りで共通）
async function askWithImage({ apiKey, effort, system, schema, imageBase64, mediaType, text }) {
  let mod;
  try { mod = await loadSdk(); }
  catch (e) { throw new PhotoAIError("判定の部品を読み込めませんでした。インターネットにつながっているか確かめてください。"); }
  const { default: Anthropic } = mod;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let res;
  try {
    // 安全上の理由で断られたとき、サーバー側で別のモデルが引き継ぐ（fallbacks: "default"）
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: { type: "json_schema", schema } },
      system,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text },
        ],
      }],
    });
  } catch (e) {
    // 具体的なものから順に見分ける
    if (e instanceof mod.AuthenticationError) throw new PhotoAIError("API キーが正しくありません。右上の設定で入れ直してください。");
    if (e instanceof mod.PermissionDeniedError) throw new PhotoAIError("この API キーでは使えません（権限がありません）。");
    if (e instanceof mod.RateLimitError) throw new PhotoAIError("短い間に使いすぎました。少し待ってからもう一度試してください。");
    if (e instanceof mod.BadRequestError) {
      const msg = String(e.message || "");
      if (/credit balance/i.test(msg)) throw new PhotoAIError("Anthropic のクレジット残高が足りません。コンソールでチャージしてください。");
      throw new PhotoAIError("写真を送れませんでした（" + msg.slice(0, 120) + "）");
    }
    if (e instanceof mod.APIConnectionError) throw new PhotoAIError("通信できませんでした。インターネットにつながっているか確かめてください。");
    if (e instanceof mod.APIError) throw new PhotoAIError("判定でエラーが起きました（" + (e.status || "") + "）。時間をおいて試してください。");
    throw e;
  }

  const u = res.usage || {};
  const yen = ((u.input_tokens || 0) * PRICE_IN + (u.output_tokens || 0) * PRICE_OUT) * YEN_PER_USD;

  if (res.stop_reason === "refusal") throw Object.assign(new PhotoAIError("この写真は判定できませんでした。別の写真で試してください。"), { yen });
  if (res.stop_reason === "max_tokens") throw Object.assign(new PhotoAIError("判定が途中で終わりました。もう一度試してください。"), { yen });

  const body = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  let data;
  try { data = JSON.parse(body); }
  catch (e) { throw Object.assign(new PhotoAIError("判定結果を読み取れませんでした。もう一度試してください。"), { yen }); }
  return { data, yen, usage: u };
}
