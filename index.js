import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ===================== CONFIG =====================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const HUMAN_WHATSAPP_NUMBER = "+393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = "299";
const PRICE_OFFER = "195";
const PRICE_SPECIAL = "125";

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== MEMÓRIA RAM =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0,                 // STAGE 0 → 4
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      humanNotified: false
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function humanDelay(text) {
  const l = text.length;
  if (l <= 80) return sleep(3000);
  if (l <= 240) return sleep(8000);
  return sleep(15000);
}

const normalize = (t) =>
  t.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();

const containsAny = (t, arr) => arr.some(w => t.includes(w));

const isPriceQuestion = (t) =>
  containsAny(t, ["preco", "valor", "quanto", "custa", "investimento"]);

const isCheckoutIntent = (t) =>
  containsAny(t, ["comprar", "pagar", "manda o link", "link", "pix", "cartao", "boleto"]);

const isExpensive = (t) =>
  containsAny(t, ["caro", "muito caro", "ta caro", "tá caro", "sem dinheiro"]);

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000;
}

function stripUrls(t) {
  return t.replace(/https?:\/\/\S+/gi, "");
}

// ===================== LOG =====================
function log(type, msg) {
  const line = `[${new Date().toISOString()}] [${type}] ${msg}\n`;
  console.log(line);
  fs.appendFileSync("bot.log", line);
}

// ===================== WHATSAPP =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function avisarHumano(texto) {
  await enviarMensagem(
    HUMAN_WHATSAPP_NUMBER,
    `🔥 LEAD QUENTE 🔥\n\n${texto}`
  );
}

// ===================== PROMPT =====================
function systemPrompt(stage) {
  return `
Você é Sarah, consultora premium da Sia Mega.
Você conversa como HUMANA REAL no WhatsApp Brasil.

REGRAS:
- 1 frase + 1 pergunta
- Nunca diga que é IA
- Tom natural e profissional
- Nunca envie link sem pedido
- Conduza sem pressão

ESTÁGIO ATUAL DO LEAD: ${stage}

COMPORTAMENTO:
STAGE 0-1 → Conectar e perguntar
STAGE 2 → Explicar valor e método
STAGE 3 → Focar decisão
STAGE 4 → Tratar objeção e fechar

PRODUTO:
Mapa Diamond é um método prático de renda online para iniciantes.
Ensina passo a passo como criar fontes de renda digital,
evitar erros comuns e aplicar estratégias simples que funcionam.

BENEFÍCIOS:
- Direção clara
- Método validado
- Menos tentativa e erro
- Resultados reais
- Suporte e acompanhamento

PREÇO:
Valor: R$ ${PRICE_FULL}
Oferta hoje: R$ ${PRICE_OFFER}
R$ ${PRICE_SPECIAL} apenas após 2 objeções

Finalize sempre com pergunta estratégica.
`;
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": ch } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(ch);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg?.text?.body) return res.sendStatus(200);

    const from = msg.from;
    const raw = msg.text.body;
    const t = normalize(raw);
    const session = getSession(from);

    log("RECEBIDO", `${from}: ${raw}`);

    // ====== ATUALIZA STAGE ======
    if (session.stage === 0 && session.history.length > 0) session.stage = 1;
    if (containsAny(t, ["funciona", "como funciona", "suporte", "garantia"])) session.stage = Math.max(session.stage, 2);
    if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;
    if (isExpensive(t)) {
      session.expensiveCount++;
      session.stage = 4;
    }

    // ====== AVISA HUMANO (1x) ======
    if (session.stage >= 3 && !session.humanNotified) {
      await avisarHumano(`Número: ${from}\nEstágio: ${session.stage}\nMensagem: "${raw}"`);
      session.humanNotified = true;
    }

    // ====== PREÇO ======
    if (isPriceQuestion(t)) {
      const reply = `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER}. Isso faz sentido pra você agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return res.sendStatus(200);
    }

    // ====== COMPRA ======
    if (isCheckoutIntent(t) && canSendLink(session)) {
      session.linkSentAt = Date.now();
      const reply = `Perfeito 🙂 Aqui está o link com a oferta de hoje:\n${LINK_OFFER}\n\nPrefere pagar à vista ou parcelado?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return res.sendStatus(200);
    }

    // ====== IA ======
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt(session.stage) },
        ...session.history.slice(-6),
        { role: "user", content: raw }
      ]
    });

    let reply = stripUrls(completion.choices[0].message.content);

    session.history.push({ role: "user", content: raw });
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
