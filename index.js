// ===================== IMPORTS =====================
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const HUMAN_WHATSAPP_NUMBER =
  process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195;
const PRICE_SPECIAL = 125;

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== ESTABILIDADE GLOBAL =====================
process.on("unhandledRejection", (err) => {
  log("FATAL", "UnhandledRejection", safeErr(err));
});
process.on("uncaughtException", (err) => {
  log("FATAL", "UncaughtException", safeErr(err));
});

// ===================== MEMÓRIA EM RAM =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0,
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      humanNotified: false,
      lastInboundId: null,
      queue: Promise.resolve(),
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  const min = 1500;
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

// ===================== INTENÇÕES =====================
function isPriceQuestion(t) {
  return containsAny(t, ["preco", "preço", "valor", "quanto", "custa"]);
}

function isCheckoutIntent(t) {
  return containsAny(t, [
    "quero comprar",
    "comprar",
    "pagar",
    "manda o link",
    "link de pagamento",
    "pix",
    "cartao",
    "cartão",
    "boleto",
    "finalizar",
  ]);
}

function isExpensive(t) {
  return containsAny(t, ["caro", "muito caro", "ta caro", "tá caro"]);
}

function isConfused(t) {
  return containsAny(t, [
    "como assim",
    "não entendi",
    "nao entendi",
    "hã",
    "hein",
    "?",
  ]);
}

function isInterested(t) {
  return containsAny(t, ["funciona", "como funciona", "suporte", "garantia"]);
}

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000;
}

function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

function truncate(text, max = 700) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function safeErr(err) {
  try {
    if (err?.response?.data) return JSON.stringify(err.response.data);
    if (err?.message) return err.message;
    return String(err);
  } catch {
    return "erro_desconhecido";
  }
}

// ===================== LOG =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  try {
    fs.appendFileSync("bot.log", line);
  } catch {}
}

// ===================== WHATSAPP =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 15000,
    }
  );
}

// ===================== PROMPT =====================
function systemPrompt(stage, expensiveCount) {
  return `
Você é Sarah, consultora premium da Sia Mega.
Converse como humana real no WhatsApp Brasil.

Regras:
- 1 frase + 1 pergunta
- Nunca diga que é IA
- Linguagem simples e natural

Produto:
${PRODUCT_NAME} é um método prático e validado para iniciantes criarem renda digital com direção.

Estágio: STAGE_${stage}

Preço:
R$ ${PRICE_FULL} (oficial)
R$ ${PRICE_OFFER} (oferta)
R$ ${PRICE_SPECIAL} apenas se expensiveCount >= 2
`;
}

// ===================== OPENAI =====================
async function callOpenAI(messages) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });
    return completion?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    log("OPENAI_ERR", "Falha OpenAI", safeErr(e));
    return null;
  }
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const session = getSession(from);

      const messageId = msg.id;
      if (messageId && session.lastInboundId === messageId) return;
      session.lastInboundId = messageId;

      session.queue = session.queue.then(() =>
        handleMessage({ msg, from, session })
      );
    } catch (e) {
      log("POST_ERR", "Falha webhook", safeErr(e));
    }
  });
});

// ===================== HANDLER =====================
async function handleMessage({ msg, from, session }) {
  try {
    if (msg.type !== "text") {
      const reply = "Recebi sua mensagem 🙂\nVocê pode me explicar em texto o que precisa?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    const raw = msg.text.body;
    const t = normalize(raw);

    if (raw.length < 4 || isConfused(t)) {
      const reply =
        "Perfeito, vou explicar melhor 🙂\nVocê quer entender como funciona o método ou o valor?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    if (isPriceQuestion(t)) {
      const reply = `O valor é R$ ${PRICE_FULL}, mas hoje sai por R$ ${PRICE_OFFER} 🙂\nFaz sentido pra você agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    if (isCheckoutIntent(t)) {
      const reply = `Aqui está o link da oferta de hoje:\n${LINK_OFFER}\nPrefere pagar à vista ou parcelado?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    const aiReply =
      (await callOpenAI([
        { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
        { role: "user", content: raw },
      ])) ||
      "Entendi 🙂\nVocê busca renda extra ou algo mais consistente?";

    const reply = truncate(stripUrls(aiReply));

    await humanDelay(reply);
    await enviarMensagem(from, reply);
  } catch (e) {
    log("HANDLER_ERR", "Erro no handler", safeErr(e));
    const reply = "Deixa eu te explicar melhor 🙂\nO que você quer entender agora?";
    await enviarMensagem(from, reply);
  }
}

// ===================== START =====================
app.listen(PORT, () =>
  log("START", `Rodando na porta ${PORT}`)
);

