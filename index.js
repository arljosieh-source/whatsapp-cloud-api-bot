import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ===================== CONFIGURAÇÃO =====================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Número humano que recebe aviso
const HUMAN_WHATSAPP_NUMBER = "+393420261950";

// Produto
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = "299";
const PRICE_OFFER = "195";
const PRICE_SPECIAL = "125";

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== OPENAI =====================
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ===================== MEMÓRIA EM RAM =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      leadNotified: false,
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = text.length;
  if (len <= 80) return sleep(3000);
  if (len <= 240) return sleep(8000);
  return sleep(15000);
}

function normalize(t) {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function containsAny(t, arr) {
  return arr.some((w) => t.includes(w));
}

const isPriceQuestion = (t) =>
  containsAny(t, ["preco", "valor", "quanto", "custa", "investimento"]);

const isCheckoutIntent = (t) =>
  containsAny(t, [
    "quero comprar",
    "comprar",
    "pagar",
    "manda o link",
    "link",
    "pix",
    "cartao",
    "cartão",
    "boleto",
  ]);

const isExpensive = (t) =>
  containsAny(t, ["caro", "muito caro", "ta caro", "tá caro"]);

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000;
}

function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/gi, "");
}

// ===================== LOG =====================
function log(type, msg) {
  const line = `[${new Date().toISOString()}] [${type}] ${msg}\n`;
  console.log(line);
  fs.appendFileSync("bot.log", line);
}

// ===================== WHATSAPP =====================
async function enviarMensagem(para, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: para,
      text: { body: texto },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===================== AVISO HUMANO =====================
async function avisarHumano(texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: HUMAN_WHATSAPP_NUMBER,
      text: { body: `🔥 LEAD QUENTE 🔥\n\n${texto}` },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===================== PROMPT =====================
function systemPrompt() {
  return `
Você é Sarah, consultora premium da Sia Mega.
Você conversa como humana real no WhatsApp Brasil.

REGRAS:
- 1 frase + 1 pergunta
- Tom informal profissional
- Nunca diga que é IA
- Nunca envie link sem o cliente pedir
- Sempre conduza para decisão

PREÇO:
Preço oficial: R$ ${PRICE_FULL}
Oferta padrão HOJE: R$ ${PRICE_OFFER}
R$ ${PRICE_SPECIAL} somente após 2 objeções de preço

Finalize sempre com pergunta estratégica.
`;
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } =
    req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg?.text?.body) return res.sendStatus(200);

    const from = msg.from;
    const textRaw = msg.text.body;
    const text = normalize(textRaw);
    const session = getSession(from);

    log("RECEBIDO", `${from}: ${textRaw}`);

    // PREÇO
    if (isPriceQuestion(text)) {
      session.priceExplained = true;
      const reply = `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER}. Isso faz sentido pra você agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return res.sendStatus(200);
    }

    // OBJEÇÃO
    if (isExpensive(text)) session.expensiveCount++;

    // INTENÇÃO DE COMPRA
    if (isCheckoutIntent(text)) {
      if (!session.leadNotified) {
        await avisarHumano(`Número: ${from}\nMensagem: "${textRaw}"`);
        session.leadNotified = true;
      }

      if (canSendLink(session)) {
        session.linkSentAt = Date.now();
        const reply = `Perfeito 🙂 Aqui está o link com a oferta de hoje:\n${LINK_OFFER}\n\nPrefere pagar à vista ou parcelado?`;
        await humanDelay(reply);
        await enviarMensagem(from, reply);
      }
      return res.sendStatus(200);
    }

    // IA
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt() },
        ...session.history.slice(-6),
        { role: "user", content: textRaw },
      ],
    });

    let reply = completion.choices[0].message.content;
    reply = stripUrls(reply);

    session.history.push({ role: "user", content: textRaw });
    session.history.push({ role: "assistant", content: reply });

    await humanDelay(reply);
    await enviarMensagem(from, reply);

    return res.sendStatus(200);
  } catch (e) {
    log("ERRO", e.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
