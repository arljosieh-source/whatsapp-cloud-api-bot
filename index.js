import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import crypto from "crypto";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// número humano (somente dígitos + código país)
const HUMAN_WHATSAPP_NUMBER = process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195;   // 35% OFF
const PRICE_SPECIAL = 125; // só após 2 objeções reais de preço

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== MODOS =====================
// AVISO HUMANO: "on" ou "off"
const NOTIFY_HUMAN = "on"; // você pode trocar para "off" se quiser
// avisar humano só 1x por lead (você escolheu isso)
const NOTIFY_ONLY_ONCE = true;

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== CHECK ENV =====================
if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.warn(
    "⚠️ Variáveis faltando. Confira: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY"
  );
}

// ===================== MEMÓRIA (RAM) =====================
// Reinicia quando Render reinicia (você escolheu assim)
const sessions = new Map();
/**
 * session = {
 *  history: [{role, content}],
 *  stage: 0..4,
 *  priceExplained: bool,
 *  expensiveCount: number,
 *  linkSentAt: number|null,
 *  humanNotified: bool,
 *  lastInboundIds: Set<string>,   // dedupe de mensagens
 *  lastUserTextHash: string|null, // dedupe de conteúdo
 * }
 */
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0,
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      humanNotified: false,
      lastInboundIds: new Set(),
      lastUserTextHash: null,
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  const min = 1500; // nunca instantâneo
  let ms = 3000;
  if (len > 240) ms = 15000;
  else if (len > 80) ms = 8000;
  await sleep(Math.max(ms, min));
}

function normalize(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function containsAny(t, arr) {
  return arr.some((w) => t.includes(w));
}

function isPriceQuestion(t) {
  return containsAny(t, ["preco", "preço", "valor", "quanto", "custa", "investimento"]);
}

function isCheckoutIntent(t) {
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "comprar",
    "pagar",
    "manda o link",
    "me manda o link",
    "link",
    "link de pagamento",
    "como pagar",
    "como pago",
    "pix",
    "cartao",
    "cartão",
    "boleto",
    "finalizar",
  ]);
}

function isExpensive(t) {
  return containsAny(t, ["caro", "muito caro", "ta caro", "tá caro", "sem dinheiro", "apertado"]);
}

function isInterested(t) {
  return containsAny(t, ["funciona", "como funciona", "suporte", "garantia", "serve pra mim"]);
}

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000; // 2 min
}

function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

function truncate(text, max = 800) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function hashText(t) {
  return crypto.createHash("sha1").update(t || "").digest("hex");
}

// ===================== LOGS =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  try {
    fs.appendFileSync("bot.log", line);
  } catch {}
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const line =
`========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================\n`;
  try {
    fs.appendFileSync("leads_quentes.txt", line);
  } catch {}
}

// ===================== WHATSAPP API =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
}

async function avisarHumano(texto) {
  // Aviso simples pro humano
  await enviarMensagem(HUMAN_WHATSAPP_NUMBER, `🔥 LEAD QUENTE 🔥\n\n${texto}`);
}

// ============ MÍDIA: pegar URL e baixar arquivo ============
// 1) pega info do media_id => url + mime_type
async function getMediaInfo(mediaId) {
  const { data } = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 20000,
    }
  );
  return data; // { url, mime_type, sha256, file_size, id }
}

// 2) baixa o arquivo binário usando a URL retornada
async function downloadMedia(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

// ===================== MÍDIA: TRANSCRIÇÃO (ÁUDIO) =====================
async function transcribeAudio(buffer, mimeType = "audio/ogg") {
  // OpenAI SDK aceita File/Blob no browser; no Node usamos File via undici (Node 18+).
  // Aqui fazemos um fallback simples criando um File com global File se existir.
  // Se não existir, usamos um truque com "new Blob".
  const filename = `audio.${mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : "wav"}`;

  // Node 18+ geralmente tem Blob
  const blob = new Blob([buffer], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  const result = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return (result?.text || "").trim();
}

// ===================== MÍDIA: VISÃO (IMAGEM) =====================
async function describeImageForContext(imageBuffer, mimeType = "image/jpeg") {
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const system = `
Você é Sarah, consultora premium da Sia Mega.
Você vai DESCREVER a imagem de forma objetiva e curta, em português do Brasil, focando no que aparece e no que isso pode significar para a conversa.
Sem inventar coisas que não aparecem.
Retorne em 3 a 6 linhas curtas.
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Descreva a imagem para contexto da conversa." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// ===================== OBJEÇÕES PADRÃO (sem IA) =====================
const OBJECTIONS = [
  {
    key: "funciona",
    match: (t) => t.includes("funciona"),
    answer:
      "Funciona sim, quando a pessoa aplica do jeito certo 🙂\nVocê quer usar isso mais pra aprender do zero ou pra começar a gerar renda?",
  },
  {
    key: "tempo",
    match: (t) => t.includes("quanto tempo") || (t.includes("resultado") && t.includes("tempo")),
    answer:
      "Depende do seu ritmo e da execução 🙂\nVocê tá buscando resultado mais rápido ou pensa em médio prazo?",
  },
  {
    key: "ja_tentei",
    match: (t) => t.includes("ja tentei") || t.includes("já tentei") || t.includes("nao deu certo") || t.includes("não deu certo"),
    answer:
      "Entendo, isso é bem comum quando falta direção.\nO que mais te travou naquela vez?",
  },
  {
    key: "medo_dinheiro",
    match: (t) => t.includes("medo") && t.includes("dinheiro"),
    answer:
      "Faz sentido ter esse receio.\nSeu medo é mais de investir errado ou de continuar como tá hoje?",
  },
  {
    key: "aparecer",
    match: (t) => t.includes("aparecer") || t.includes("gravar video") || t.includes("gravar vídeo"),
    answer:
      "Não é obrigatório 🙂\nVocê prefere algo mais discreto no começo?",
  },
  {
    key: "suporte",
    match: (t) => t.includes("suporte"),
    answer:
      "Tem suporte sim 😊\nPra você, ter acompanhamento faz diferença?",
  },
  {
    key: "parcelar",
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    answer:
      "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== PROMPT (produção, com infos do produto) =====================
function systemPrompt(stage, expensiveCount) {
  // Importante: o texto do produto está presente, mas a IA é obrigada a falar curto.
  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS OBRIGATÓRIAS:
- Nunca diga que é IA, robô, sistema ou automação.
- Estilo WhatsApp BR: curto, direto e humano.
- Regra de formato: 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Conduza para o próximo passo com naturalidade.

ESTÁGIO ATUAL DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: valor + clareza (sem preço)
- STAGE_3: decisão (objetivo é fechar)
- STAGE_4: objeção de preço (validar, perguntar, valor, fechar)

PRODUTO (use em frases curtas):
O ${PRODUCT_NAME} é um método comprovado de renda extra e crescimento no digital.
Ele ensina passo a passo ações práticas para desbloquear novas fontes de lucro, aumentar autoridade digital e vender online com estratégia.
Pontos fortes que você pode citar (sempre curto): método validado, clareza, direção, menos tentativa e erro, suporte, acesso imediato, garantia 7 dias, pagamento seguro.

GUARDIÃO DO PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e pergunte se faz sentido.
- Nunca liste vários preços.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que expensiveCount >= 2 e já tenha feito perguntas persuasivas.
- Links só se o cliente pedir claramente (manda link / quero comprar / como pagar).

Links:
- Oferta (R$ ${PRICE_OFFER}): ${LINK_OFFER}
- Integral: ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL}

Se houver mídia (imagem/áudio), use o contexto entregue para responder melhor, sem inventar.
`;
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("WEBHOOK", "Verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // responde 200 rápido para Meta (evita reentrega e duplicação)
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const messageId = msg.id || null;

    const session = getSession(from);

    // ===================== DEDUPE (anti-dupla resposta) =====================
    if (messageId) {
      if (session.lastInboundIds.has(messageId)) {
        log("DEDUPE", `Msg duplicada ignorada`, `from=${from} id=${messageId}`);
        return;
      }
      session.lastInboundIds.add(messageId);
      // mantém o set pequeno
      if (session.lastInboundIds.size > 30) {
        // remove os mais antigos (não temos ordem no Set, então reset simples)
        session.lastInboundIds = new Set(Array.from(session.lastInboundIds).slice(-15));
      }
    }

    // ===================== IDENTIFICA TIPO =====================
    const type = msg.type; // "text", "audio", "image", "document", "video", etc.
    let rawText = msg.text?.body || "";
    let userTextForLogic = "";
    let extraContext = "";

    // ===================== TRATA MÍDIA =====================
    if (type === "audio" || type === "voice") {
      const mediaId = msg.audio?.id || msg.voice?.id;
      if (!mediaId) {
        const reply = "Vi que você mandou um áudio, mas não consegui acessar aqui.\nVocê consegue me dizer em 1 frase o que você quer resolver?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);
        return;
      }

      const info = await getMediaInfo(mediaId);
      const buffer = await downloadMedia(info.url);
      const transcript = await transcribeAudio(buffer, info.mime_type || "audio/ogg");

      rawText = transcript || "";
      userTextForLogic = normalize(rawText);

      extraContext = transcript
        ? `Cliente enviou áudio. Transcrição: "${transcript}"`
        : "Cliente enviou áudio, mas a transcrição veio vazia.";
      log("AUDIO", `from=${from}`, transcript ? `"${transcript}"` : "sem transcrição");
    } else if (type === "image") {
      const mediaId = msg.image?.id;
      const caption = msg.image?.caption || "";

      if (!mediaId) {
        const reply = "Recebi sua imagem, mas não consegui abrir aqui.\nVocê pode me dizer em 1 frase o que você quer analisar nela?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);
        return;
      }

      const info = await getMediaInfo(mediaId);
      const buffer = await downloadMedia(info.url);

      const imageDesc = await describeImageForContext(buffer, info.mime_type || "image/jpeg");

      // se tiver legenda, usa como texto principal; senão, pede intenção
      rawText = caption?.trim() || "Enviei uma imagem.";
      userTextForLogic = normalize(rawText);

      extraContext =
        `Cliente enviou imagem.\nLegenda: "${caption || "(sem legenda)"}"\nDescrição da imagem: ${imageDesc}`;
      log("IMAGE", `from=${from}`, `caption="${caption || ""}"`);
    } else if (type === "document" || type === "video" || type === "sticker") {
      // Não trava mais: responde pedindo texto / objetivo
      const reply =
        "Recebi seu arquivo 🙂\nVocê quer que eu analise o quê exatamente nele (me diga em 1 frase)?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      // salva histórico mínimo
      session.history.push({ role: "user", content: `[${type}]` });
      session.history.push({ role: "assistant", content: reply });
      return;
    } else {
      // texto normal
      rawText = msg.text?.body || "";
      if (!rawText) return;
      userTextForLogic = normalize(rawText);
    }

    // ===================== DEDUPE por conteúdo (anti-repetição boba) =====================
    const textHash = hashText(`${from}|${rawText}`);
    if (session.lastUserTextHash === textHash) {
      log("DEDUPE_TEXT", `Conteúdo repetido ignorado`, `from=${from}`);
      return;
    }
    session.lastUserTextHash = textHash;

    log("IN", `${from}`, `"${rawText}" type=${type} stage=${session.stage}`);

    // ===================== UPDATE STAGE =====================
    if (session.stage === 0 && session.history.length > 0) session.stage = 1;
    if (isInterested(userTextForLogic)) session.stage = Math.max(session.stage, 2);
    if (isPriceQuestion(userTextForLogic) || isCheckoutIntent(userTextForLogic)) session.stage = 3;

    if (isExpensive(userTextForLogic)) {
      session.expensiveCount += 1;
      session.stage = 4;
    }

    // ===================== AVISA HUMANO (sem atrapalhar conversa) =====================
    // IMPORTANTE: NÃO manda mensagem extra pro cliente, só avisa humano.
    if (
      NOTIFY_HUMAN === "on" &&
      session.stage >= 3 &&
      (!NOTIFY_ONLY_ONCE || !session.humanNotified)
    ) {
      const motivo = session.stage === 4 ? "Objeção de preço / decisão" : "Lead quente (preço/compra)";
      await avisarHumano(
        `Número: ${from}\nMotivo: ${motivo}\nStage: ${session.stage}\nMensagem: "${rawText}"`
      );
      registrarLeadQuente({ phone: from, motivo, mensagem: rawText });
      session.humanNotified = true;
    }

    // ===================== OBJEÇÕES PADRÃO (sem IA) =====================
    for (const item of OBJECTIONS) {
      if (item.match(userTextForLogic)) {
        const reply = item.answer;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: rawText });
        session.history.push({ role: "assistant", content: reply });
        return;
      }
    }

    // ===================== PREÇO (guardião) =====================
    if (isPriceQuestion(userTextForLogic)) {
      session.priceExplained = true;

      const reply =
        `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nIsso faz sentido pra você agora?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: rawText });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== INTENÇÃO DE COMPRA (link só se pedir) =====================
    if (isCheckoutIntent(userTextForLogic)) {
      if (!canSendLink(session)) {
        const reply = "Perfeito.\nVocê prefere pagar à vista ou parcelado?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: rawText });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      session.linkSentAt = Date.now();
      const reply =
        `Fechado 🙂\nAqui está o link com a oferta de hoje (R$ ${PRICE_OFFER}):\n${LINK_OFFER}\nPrefere pagar à vista ou parcelado?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: rawText });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== IA (conversa) =====================
    // Monta a mensagem do usuário com contexto de mídia, se existir
    const userContent = extraContext
      ? `${rawText}\n\n[CONTEXTO EXTRA]\n${extraContext}`
      : rawText;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
        ...session.history.slice(-10),
        { role: "user", content: userContent },
      ],
    });

    let reply = completion.choices?.[0]?.message?.content?.trim() ||
      "Entendi.\nMe conta seu objetivo pra eu te orientar certinho?";

    reply = truncate(reply, 900);

    // ===================== GUARDIÕES FINAIS =====================
    // 1) sem links se não pediu
    if (!isCheckoutIntent(userTextForLogic)) reply = stripUrls(reply);

    // 2) preço só quando perguntou preço (ou se já explicou antes e está em objeção)
    if (!isPriceQuestion(userTextForLogic) && !session.priceExplained) {
      reply = reply.replace(/R\$\s?\d+([.,]\d+)?/g, "").trim();
    }

    // 3) não soltar 125 cedo
    if (session.expensiveCount < 2) {
      reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
    }

    // 4) corta se vier vazio
    if (!reply || reply.length < 2) {
      reply = "Entendi.\nSeu objetivo é renda extra ou algo mais consistente?";
    }

    session.history.push({ role: "user", content: rawText });
    session.history.push({ role: "assistant", content: reply });

    log("OUT", `${from}`, `"${reply}" stage=${session.stage}`);

    await humanDelay(reply);
    await enviarMensagem(from, reply);
  } catch (e) {
    const err = e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e);
    log("ERROR", "Webhook falhou", err);
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
