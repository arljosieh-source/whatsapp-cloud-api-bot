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

// Número humano para aviso (somente números, com DDI) ex: 5573998498514
const HUMAN_WHATSAPP_NUMBER =
  process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195; // 35% OFF (sempre)
const PRICE_SPECIAL = 125; // só após >=2 objeções reais

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== CHECK ENV =====================
function ensureEnv() {
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!WHATSAPP_TOKEN) missing.push("WHATSAPP_TOKEN");
  if (!PHONE_NUMBER_ID) missing.push("PHONE_NUMBER_ID");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    log("ENV_MISSING", `Faltando: ${missing.join(", ")}`);
  }
}
ensureEnv();

// ===================== LOG =====================
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

// ===================== MEMÓRIA RAM (reinicia se Render reiniciar) =====================
const sessions = new Map();
/**
 * session = {
 *   history: [{role, content}],
 *   stage: 0..4,
 *   priceExplained: boolean,
 *   expensiveCount: number,
 *   linkSentAt: number|null,
 *   humanNotified: boolean,
 *   lastInboundId: string|null,
 *   lastUserTextNorm: string|null
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
      lastInboundId: null,
      lastUserTextNorm: null,
    });
  }
  return sessions.get(from);
}

// ===================== FILA POR USUÁRIO (anti-concorrência) =====================
const locks = new Map();
async function withUserLock(from, fn) {
  const prev = locks.get(from) || Promise.resolve();
  let release;
  const current = new Promise((res) => (release = res));
  locks.set(from, prev.then(() => current));

  try {
    await prev; // espera a fila anterior
    return await fn();
  } finally {
    release();
    // limpa lock se ninguém mais está na fila
    setTimeout(() => {
      if (locks.get(from) === current) locks.delete(from);
    }, 1000).unref?.();
  }
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

function isPriceQuestion(t) {
  return containsAny(t, [
    "preco",
    "preço",
    "valor",
    "quanto",
    "custa",
    "investimento",
    "mensalidade",
  ]);
}

function isCheckoutIntent(t) {
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "comprar",
    "pagar",
    "manda o link",
    "me manda o link",
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
  return containsAny(t, [
    "caro",
    "muito caro",
    "ta caro",
    "tá caro",
    "sem dinheiro",
    "apertado",
    "nao tenho dinheiro",
    "não tenho dinheiro",
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

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000; // 2 min
}

function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

function truncate(text, max = 700) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// ===================== WHATSAPP SEND =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// ===================== AVISO HUMANO (1x por lead) =====================
async function avisarHumano(texto) {
  try {
    await enviarMensagem(
      HUMAN_WHATSAPP_NUMBER,
      `🔥 LEAD QUENTE 🔥\n\n${texto}`
    );
  } catch (e) {
    log("WARN", "Falha ao avisar humano", e?.message || "");
  }
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
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("WEBHOOK", "Verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== PROCESSAMENTO ASSÍNCRONO (anti-timeout / anti-trava) =====================
app.post("/webhook", (req, res) => {
  // SEMPRE responde 200 rápido pra Meta (evita reentrega e travas)
  res.sendStatus(200);

  void handleWebhook(req.body).catch((e) => {
    log("ERROR", "handleWebhook crash", e?.message || "");
  });
});

async function handleWebhook(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const from = msg.from;
  const messageId = msg.id || null;
  const type = msg.type; // "text", "audio", "image", "video", "document", etc.

  // trava por usuário (evita bagunçar histórico / duplicar)
  await withUserLock(from, async () => {
    const session = getSession(from);

    // dedupe (Meta pode reentregar)
    if (messageId && session.lastInboundId === messageId) {
      log("DEDUPE", "Ignorado msg duplicada", `from=${from} id=${messageId}`);
      return;
    }
    session.lastInboundId = messageId;

    // ====== MÍDIA: NÃO TRAVA (responde e segue) ======
    if (type !== "text") {
      // (Por estabilidade, não tentamos baixar/transcrever aqui)
      const reply =
        "Recebi seu arquivo 🙂\nPra eu te ajudar certinho, você consegue me dizer em 1 frase o que você quer resolver com isso?";
      log("IN_MEDIA", `${from}`, `type=${type}`);
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      // salva histórico mínimo
      session.history.push({ role: "user", content: `[${type} recebido]` });
      session.history.push({ role: "assistant", content: reply });

      return;
    }

    const raw = msg.text?.body;
    if (!raw) return;

    const t = normalize(raw);

    log("IN", `${from}`, `"${raw}" stage=${session.stage}`);

    // ====== GUARDIÃO: mensagem vazia/muito curta ======
    if (t.length < 2) {
      const reply = "Me diz só um pouquinho mais 🙂\nVocê quer renda extra ou algo mais consistente?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // ====== GUARDIÃO: mensagem repetida ======
    if (session.lastUserTextNorm && session.lastUserTextNorm === t) {
      log("GUARD", "Mensagem repetida ignorada", `from=${from}`);
      const reply = "Entendi 🙂\nVocê quer que eu te explique como funciona ou você quer ir direto pra oferta de hoje?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }
    session.lastUserTextNorm = t;

    // ===================== UPDATE STAGE =====================
    if (session.stage === 0 && session.history.length > 0) session.stage = 1;
    if (isInterested(t)) session.stage = Math.max(session.stage, 2);
    if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;
    if (isExpensive(t)) {
      session.expensiveCount += 1;
      session.stage = 4;
    }

    // ===================== LEAD QUENTE: AVISA HUMANO (silencioso) =====================
    // (sem mandar mensagem extra pro cliente)
    if (session.stage >= 3 && !session.humanNotified) {
      await avisarHumano(
        `Número: ${from}\nStage: ${session.stage}\nMsg: "${raw}"`
      );
      registrarLeadQuente({
        phone: from,
        motivo: `Lead quente (STAGE_${session.stage})`,
        mensagem: raw,
      });
      session.humanNotified = true;
    }

    // ===================== RESPOSTAS PADRÃO =====================
    for (const item of OBJECTIONS) {
      if (item.match(t)) {
        const reply = item.reply;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }
    }

    // ===================== PREÇO (REGRA FIXA) =====================
    if (isPriceQuestion(t)) {
      session.priceExplained = true;
      const reply =
        `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nIsso faz sentido pro seu objetivo agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: raw });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== LINK (SÓ SE PEDIR) =====================
    if (isCheckoutIntent(t)) {
      if (!canSendLink(session)) {
        const reply = "Perfeito 🙂\nVocê prefere pagar à vista ou parcelado?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      session.linkSentAt = Date.now();
      const reply =
        `Fechado 🙂\nAqui está o link com a oferta de hoje (R$ ${PRICE_OFFER}):\n${LINK_OFFER}\nVocê prefere pagar à vista ou parcelado?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: raw });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== IA (COM GUARDIÕES) =====================
    let reply = "";

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          ...session.history.slice(-8),
          { role: "user", content: raw },
        ],
        temperature: 0.7,
      });

      reply =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Entendi 🙂\nVocê quer renda extra ou algo mais consistente?";
    } catch (e) {
      log("OPENAI_FAIL", "Fallback de resposta", e?.message || "");
      reply = "Entendi 🙂\nMe diz: seu objetivo é renda extra ou algo mais consistente?";
    }

    // ====== GUARDIÕES FINAIS ======
    reply = truncate(reply, 700);

    // nunca mandar link se não pediram
    if (!isCheckoutIntent(t)) reply = stripUrls(reply);

    // preço só se o cliente perguntou preço
    if (!session.priceExplained && !isPriceQuestion(t)) {
      reply = reply.replace(/R\$\s?\d+([.,]\d+)?/g, "").trim();
    }

    // nunca vazar 125 cedo
    if (session.expensiveCount < 2) {
      reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
    }

    // se ficar vazio depois de guards
    if (!reply || reply.length < 2) {
      reply = "Entendi 🙂\nQual é sua maior dificuldade hoje: falta de direção ou falta de confiança?";
    }

    // salva histórico
    session.history.push({ role: "user", content: raw });
    session.history.push({ role: "assistant", content: reply });

    log("OUT", `${from}`, `"${reply}" stage=${session.stage}`);

    await humanDelay(reply);
    await enviarMensagem(from, reply);
  });
}

// ===================== START =====================
app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
