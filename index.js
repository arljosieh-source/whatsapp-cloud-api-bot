import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ✅ Coloque aqui o WhatsApp do HUMANO que vai receber alerta de lead quente
// IMPORTANTE: a Meta geralmente espera só números (com DDI) sem "+".
// Ex: "+393420261950"
const HUMAN_WHATSAPP_NUMBER = "393420261950"; // <-- ajuste para o formato certo do seu número

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ====== CONFIG (ENV) ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Links / Preços (regras do seu negócio)
const PRICE_FULL = "299";
const PRICE_DISCOUNT = "195"; // 35% off
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_DISCOUNT = "https://pay.kiwify.com.br/raiY3qd";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals"; // só em caso excepcional

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY || !VERIFY_TOKEN) {
  console.warn(
    "⚠️ Variáveis faltando. Confira: WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY, VERIFY_TOKEN"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== MEMÓRIA (contexto simples por número) ======
const sessions = new Map();
/**
 * sessions.get(from) = {
 *   history: [{role, content}],
 *   lastLinkSentAt: number | null,
 *   priceAlreadyExplained: boolean,
 *   saidExpensiveCount: number,
 *   hotLeadNotified: boolean
 * }
 */
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      lastLinkSentAt: null,
      priceAlreadyExplained: false,
      saidExpensiveCount: 0,
      hotLeadNotified: false,
    });
  }
  return sessions.get(from);
}

// ====== Anti-duplicação por message.id (Meta pode enviar repetido) ======
const processedMessageIds = new Map(); // id -> timestamp
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();

  // limpa ids antigos
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
  }

  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

// ====== HELPERS ======
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Simula “tempo humano” antes de responder
async function humanDelay(text) {
  const len = (text || "").length;
  let ms = 3000; // curto
  if (len > 140) ms = 15000; // longo
  else if (len > 60) ms = 8000; // médio
  await sleep(ms);
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function containsAny(text, arr) {
  return arr.some((w) => text.includes(w));
}

// Detecta intenção “pedir preço”
function isPriceQuestion(t) {
  return containsAny(t, [
    "quanto",
    "valor",
    "preco",
    "preço",
    "custa",
    "investimento",
    "qual e o valor",
    "qual o valor",
  ]);
}

// Detecta intenção “quero comprar / manda link / pagamento”
function isCheckoutIntent(t) {
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "quero pagar",
    "manda o link",
    "me manda o link",
    "link de pagamento",
    "como pago",
    "como pagar",
    "pix",
    "cartao",
    "cartão",
    "boleto",
    "parcelar",
    "parcelamento",
    "finalizar",
  ]);
}

// Detecta “caro”
function isExpensiveObjection(t) {
  return containsAny(t, [
    "caro",
    "muito caro",
    "ta caro",
    "tá caro",
    "pesado",
    "salgado",
    "sem dinheiro",
    "nao tenho dinheiro",
    "não tenho dinheiro",
  ]);
}

// Remove URLs se não estiver autorizado a mandar link
function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

// Regras para mandar link (anti-spam simples)
function canSendLink(session) {
  const now = Date.now();
  if (!session.lastLinkSentAt) return true;
  // 2 minutos de intervalo mínimo entre links
  return now - session.lastLinkSentAt > 2 * 60 * 1000;
}

// ====== LOGS ======
function logSistema(tipo, mensagem, extra = "") {
  const logLine = `[${new Date().toISOString()}] [${tipo}] ${mensagem} ${extra}\n`;
  console.log(logLine.trim());
  try {
    fs.appendFileSync("logs_sistema.txt", logLine);
  } catch (e) {
    // em alguns hosts, FS pode ser limitado; não quebra o bot
  }
}

// Alias para não dar erro quando você chama logStep
function logStep(step, data) {
  logSistema(step, "STEP", JSON.stringify(data || {}));
}

// ====== WHATSAPP SEND ======
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

// ====== ALERTA HUMANO + REGISTRO ======
async function avisarHumano(texto) {
  // se não tiver número do humano, só ignora
  if (!HUMAN_WHATSAPP_NUMBER) return;

  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: HUMAN_WHATSAPP_NUMBER,
      text: { body: `🔥 LEAD QUENTE DETECTADO 🔥\n\n${texto}` },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const log = `
========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================
`;
  try {
    fs.appendFileSync("leads_quentes.txt", log);
  } catch (e) {
    // não quebra o bot se filesystem falhar
  }
}

// Lead quente (regras simples e úteis)
function isHotLead(session, userTextRaw) {
  const t = normalize(userTextRaw);

  const intentBuy = isCheckoutIntent(t);
  const priceObjection = session.saidExpensiveCount >= 1 && session.priceAlreadyExplained;
  const highEngagement = (session.history?.length || 0) >= 6;

  return intentBuy || priceObjection || highEngagement;
}

// ====== PROMPT ======
function buildSystemPrompt() {
  return `
Você é Sarah, consultora premium de orientação digital da empresa Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura, próxima e estratégica.

REGRAS ABSOLUTAS:
- Nunca diga que é IA/robô/sistema/automação.
- Linguagem brasileira, simples, natural, estilo WhatsApp.
- No máximo 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Uma ideia por mensagem.
- Sempre finalize com pergunta estratégica.
- Não repetir “oi/olá/tudo bem” se a conversa já começou.
- Pergunte mais do que explica.
- Não empurre venda, conduza.

PRODUTO:
Mapa Diamond (premium) para renda online e vendas online para iniciantes.

PREÇO (REGRA FIXA):
Se perguntarem valor/preço/custo:
Diga: "O valor é R$ ${PRICE_FULL}, mas hoje está com 35% de desconto e sai por R$ ${PRICE_DISCOUNT}."
NÃO liste 3 preços.
NÃO mencione o preço especial de R$ 125 a menos que o cliente insista muito em “tá caro” e você já tenha feito perguntas.

LINKS (REGRA FIXA):
Só envie link se o cliente pedir claramente (manda link / quero comprar / como pagar).
- Oferta (R$ ${PRICE_DISCOUNT}): ${LINK_DISCOUNT}
- Integral (R$ ${PRICE_FULL}): ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL} (usar raramente, com elegância)

OBJEÇÃO “TÁ CARO”:
- Validar
- Perguntar objetivo (aprender x gerar renda)
- Construir valor
- Só então reforçar o desconto de R$ ${PRICE_DISCOUNT}
- Só em último caso usar o link especial.
`;
}

// ====== ROTAS ======
app.get("/", (req, res) => res.send("✅ Sia Mega WhatsApp Bot online"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    logSistema("WEBHOOK", "✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Sempre responde 200 para a Meta não reenviar sem necessidade
    if (!message) return res.sendStatus(200);

    // anti-duplicação
    if (isDuplicateMessage(message.id)) {
      logSistema("DEDUP", `Mensagem duplicada ignorada`, `id=${message.id}`);
      return res.sendStatus(200);
    }

    const from = message.from;
    const userMessageRaw = message.text?.body;

    // ignora mensagens não-texto
    if (!userMessageRaw) return res.sendStatus(200);

    logSistema("MENSAGEM_RECEBIDA", `Número ${from}`, `Texto: "${userMessageRaw}"`);

    const session = getSession(from);
    const userText = normalize(userMessageRaw);

    // ====== 1) Regras rápidas (sem IA) ======

    // A) Pergunta de preço -> responde com 299 + oferta 195 (sem listar 3 preços)
    if (isPriceQuestion(userText)) {
      session.priceAlreadyExplained = true;

      const reply =
        `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% de desconto e sai por R$ ${PRICE_DISCOUNT}. ` +
        `Você quer usar mais pra aprender do zero ou pra começar a gerar renda o quanto antes?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: userMessageRaw });
      session.history.push({ role: "assistant", content: reply });

      logSistema("RESPOSTA_ENVIADA", `Para ${from}`, `Texto: "${reply}"`);
      return res.sendStatus(200);
    }

    // B) Objeção “caro”
    if (isExpensiveObjection(userText)) {
      session.saidExpensiveCount += 1;

      const reply =
        "Entendo, é um investimento importante. Você está olhando mais o valor agora ou o resultado lá na frente?";

      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: userMessageRaw });
      session.history.push({ role: "assistant", content: reply });

      return res.sendStatus(200);
    }

    // C) Cliente quer comprar/pagar -> manda link (com controle anti-spam) + avisa humano
    if (isCheckoutIntent(userText)) {
      // avisa humano UMA vez por conversa
      if (!session.hotLeadNotified) {
        session.hotLeadNotified = true;

        const motivoLead = "Cliente demonstrou intenção clara de compra";
        await avisarHumano(
          `Número: ${from}\nMotivo: ${motivoLead}\nMensagem: "${userMessageRaw}"`
        );
        registrarLeadQuente({
          phone: from,
          motivo: motivoLead,
          mensagem: userMessageRaw,
        });
      }

      if (!canSendLink(session)) {
        const reply =
          "Perfeito. Só pra eu te orientar direitinho: você prefere pagar à vista ou parcelar?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: userMessageRaw });
        session.history.push({ role: "assistant", content: reply });
        return res.sendStatus(200);
      }

      session.lastLinkSentAt = Date.now();

      const reply =
        `Fechado 🙂 Aqui está o link com a oferta de hoje (35% OFF):\n${LINK_DISCOUNT}\n\n` +
        `Prefere pagar à vista ou parcelar?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: userMessageRaw });
      session.history.push({ role: "assistant", content: reply });

      return res.sendStatus(200);
    }

    // ====== 2) IA (conversa) ======
    logStep("FLUXO_IA", { historico: session.history.length });

    // histórico curto para não ficar caro
    const history = session.history.slice(-8);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...history,
        { role: "user", content: userMessageRaw },
      ],
    });

    let reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) reply = "Entendi. Me conta seu objetivo pra eu te orientar melhor 🙂";

    // segurança: se IA tentar mandar link fora da hora, remove
    const wantsLink = isCheckoutIntent(userText);
    if (!wantsLink) reply = stripUrls(reply);

    // segurança: evita mencionar “125” cedo demais
    if (reply.includes("125") && session.saidExpensiveCount < 2) {
      reply = reply.replace(/125/g, PRICE_DISCOUNT);
    }

    // lead quente por engajamento (avisa humano uma vez)
    if (!session.hotLeadNotified && isHotLead(session, userMessageRaw)) {
      session.hotLeadNotified = true;

      const motivoLead = "Lead quente (engajamento/objeção/preço)";
      await avisarHumano(
        `Número: ${from}\nMotivo: ${motivoLead}\nMensagem: "${userMessageRaw}"`
      );
      registrarLeadQuente({
        phone: from,
        motivo: motivoLead,
        mensagem: userMessageRaw,
      });
    }

    session.history.push({ role: "user", content: userMessageRaw });
    session.history.push({ role: "assistant", content: reply });

    await humanDelay(reply);
    await enviarMensagem(from, reply);

    logSistema("RESPOSTA_IA", `Para ${from}`, `Texto: "${reply}"`);
    return res.sendStatus(200);
  } catch (error) {
    logSistema(
      "ERRO",
      "Falha no webhook",
      JSON.stringify(error?.response?.data || error?.message || error)
    );
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
