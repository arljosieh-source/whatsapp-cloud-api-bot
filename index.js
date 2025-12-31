import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "2mb" }));

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

// ===================== LOG =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  try { fs.appendFileSync("bot.log", line); } catch {}
}

// ===================== MEMÓRIA =====================
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
      lastUserTextNorm: null,
    });
  }
  return sessions.get(from);
}

// ===================== LOCK POR USUÁRIO =====================
const locks = new Map();
async function withUserLock(from, fn) {
  const prev = locks.get(from) || Promise.resolve();
  let release;
  const current = new Promise((res) => (release = res));
  locks.set(from, prev.then(() => current));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    setTimeout(() => {
      if (locks.get(from) === current) locks.delete(from);
    }, 500).unref?.();
  }
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  let ms = 3000;
  if (len > 240) ms = 15000;
  else if (len > 80) ms = 8000;
  await sleep(ms);
}

function normalize(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

const containsAny = (t, arr) => arr.some((w) => t.includes(w));

const isPriceQuestion = (t) =>
  containsAny(t, ["preco", "preço", "valor", "quanto", "custa", "mensalidade"]);

const isCheckoutIntent = (t) =>
  containsAny(t, [
    "quero comprar",
    "comprar",
    "pagar",
    "manda o link",
    "link de pagamento",
    "pix",
    "cartao",
    "boleto",
  ]);

const isExpensive = (t) =>
  containsAny(t, ["caro", "ta caro", "sem dinheiro", "apertado"]);

function isConfusingMessage(t) {
  return (
    t.length <= 12 ||
    [
      "como assim",
      "nao entendi",
      "não entendi",
      "hã",
      "hein",
      "explica",
      "explica melhor",
      "oi?",
    ].includes(t)
  );
}

const truncate = (t, max = 700) =>
  t.length > max ? t.slice(0, max - 3) + "..." : t;

const stripUrls = (t) => t.replace(/https?:\/\/\S+/gi, "[link]");

// ===================== WHATSAPP =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ===================== RESPOSTAS PADRÃO (SEM IA) =====================
const OBJECTIONS = [
  {
    match: (t) => t.includes("isso funciona") || t.includes("funciona mesmo"),
    reply:
      "Funciona sim, quando a pessoa aplica do jeito certo 🙂\nVocê quer usar isso mais pra aprender do zero ou pra começar a gerar renda?",
  },
  {
    match: (t) => t.includes("quanto tempo") || (t.includes("resultado") && t.includes("tempo")),
    reply:
      "Depende do seu ritmo e da execução 🙂\nVocê tá buscando algo mais rápido ou pensa em médio prazo?",
  },
  {
    match: (t) => t.includes("ja tentei") || t.includes("já tentei") || t.includes("nao deu certo") || t.includes("não deu certo"),
    reply:
      "Entendo, isso acontece bastante quando falta direção.\nO que mais te travou naquela vez?",
  },
  {
    match: (t) => t.includes("medo") && t.includes("dinheiro"),
    reply:
      "Faz sentido ter esse receio.\nSeu medo é mais de investir errado ou de continuar como tá hoje?",
  },
  {
    match: (t) => t.includes("aparecer") || t.includes("gravar video") || t.includes("gravar vídeo"),
    reply:
      "Não é obrigatório 🙂\nVocê prefere algo mais discreto no começo?",
  },
  {
    match: (t) => t.includes("suporte"),
    reply:
      "Tem suporte sim 😊\nPra você, ter acompanhamento faz diferença?",
  },
  {
    match: (t) => t.includes("garantia"),
    reply:
      "Tem garantia de 7 dias sim 🙂\nIsso te deixaria mais tranquilo(a) pra decidir?",
  },
  {
    match: (t) => t.includes("piramide") || t.includes("pirâmide"),
    reply:
      "Não é pirâmide.\nVocê já teve alguma experiência ruim com algo parecido antes?",
  },
  {
    match: (t) => t.includes("cnpj"),
    reply:
      "Não precisa de CNPJ pra começar.\nVocê quer começar simples ou já pensa em algo mais estruturado?",
  },
  {
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    reply:
      "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== PROMPT (TOM SARAH + INFO CLARA) =====================
function systemPrompt(stage, expensiveCount) {
  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS OBRIGATÓRIAS:
- Nunca diga que é IA, robô, sistema ou automação.
- Estilo WhatsApp BR: curto, direto e humano.
- 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Nunca invente informações.
- Se faltar dado, diga que confirma e faça 1 pergunta.

PRODUTO (BASE OFICIAL):
${PRODUCT_NAME} é um método estratégico e validado, feito pra quem está começando do zero no digital e quer construir renda real com direção.
Ele te entrega um passo a passo claro do que fazer, quando fazer e como aplicar — pra reduzir tentativa e erro e evitar aquelas decisões no escuro.
A ideia não é “milagre rápido”, é consistência com método: ações simples, organizadas e escaláveis, com suporte e acompanhamento.
Inclui acesso imediato e garantia de 7 dias.

PRA QUEM É:
- Iniciantes no digital
- Quem já tentou e não teve resultado
- Quem quer renda extra ou algo mais consistente
- Quem quer trabalhar de casa, no próprio ritmo
- Quem não quer depender de pirâmide, promessas vazias ou “vender curso”

BENEFÍCIOS (cite 1 ou 2 por vez, nunca todos):
direção clara, método validado, menos tentativa e erro, processo simples, suporte, acesso imediato, garantia 7 dias.

ESTÁGIO DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: valor + clareza (sem preço)
- STAGE_3: decisão (objetivo + próximo passo)
- STAGE_4: objeção de preço (validar, perguntar, construir valor)

GUARDIÃO DO PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e pergunte se faz sentido.
- Nunca liste vários preços.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que expensiveCount >= 2, depois de perguntas e construção de valor.
- Nunca envie link sem o cliente pedir claramente.

LINKS (só se o cliente pedir):
- Oferta (R$ ${PRICE_OFFER}): ${LINK_OFFER}
- Integral (R$ ${PRICE_FULL}): ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL}

Finalize sempre com pergunta estratégica.
`;
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  handleWebhook(req.body).catch((e) => log("ERR", e.message));
});

// ===================== CORE =====================
async function handleWebhook(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const session = getSession(from);

  await withUserLock(from, async () => {
    if (msg.type !== "text") {
      const reply =
        "Recebi 🙂\nVocê consegue me explicar em uma frase o que precisa?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    const raw = msg.text.body;
    const t = normalize(raw);

    // 🛡️ Guardião 1 — confuso
    if (isConfusingMessage(t)) {
      const reply = "Claro 🙂\nQual parte você quer que eu explique melhor?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // 🛡️ Guardião 5 — repetição
    if (session.lastUserTextNorm === t) {
      const reply =
        "Entendi 🙂\nVocê quer entender como funciona ou saber se faz sentido pra você?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }
    session.lastUserTextNorm = t;

    // Objeções diretas
    for (const o of OBJECTIONS) {
      if (o.match(t)) {
        await humanDelay(o.reply);
        await enviarMensagem(from, o.reply);
        return;
      }
    }

    if (isPriceQuestion(t)) {
      const reply = `O valor é R$ ${PRICE_FULL}, mas hoje sai por R$ ${PRICE_OFFER} 🙂\nFaz sentido pra você agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    if (isCheckoutIntent(t)) {
      const reply = `Perfeito 🙂\nAqui está o link da oferta:\n${LINK_OFFER}`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // IA
    let reply;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          ...session.history.slice(-8),
          { role: "user", content: raw },
        ],
      });
      reply = completion?.choices?.[0]?.message?.content?.trim();
    } catch {}

    // 🛡️ Guardião 2 + 6 — fallback absoluto
    if (!reply || reply.length < 3) {
      reply = "Me explica melhor o que você está buscando agora 🙂";
    }

    reply = truncate(stripUrls(reply));
    session.history.push({ role: "user", content: raw });
    session.history.push({ role: "assistant", content: reply });

    await humanDelay(reply);
    await enviarMensagem(from, reply);
  });
}

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
