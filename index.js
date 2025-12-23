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

// Número humano (apenas dígitos + país). Ex Itália: 393420261950
const HUMAN_WHATSAPP_NUMBER =
  (process.env.HUMAN_WHATSAPP_NUMBER || "393420261950").replace(/\D/g, "");

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195;   // 35% OFF
const PRICE_SPECIAL = 125; // só após >=2 objeções reais e com elegância

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== MODO (SUA ESCOLHA) =====================
// Opção B: bot aquece e AVISA HUMANO quando lead quente.
// Importante: agora não manda mensagem “já chamei consultor” sem necessidade.
const HANDOFF_MODE = "B";
const HANDOFF_PAUSE_MS = 5 * 60 * 1000; // 5 minutos

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== SESSIONS (RAM) =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0,                 // 0..4
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: 0,
      humanNotified: false,
      handoffUntil: 0,
      lastInboundId: null,       // dedupe
      lastInboundHash: "",       // dedupe simples
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
    "link de pagamento",
    "link",
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

function truncate(text, max = 700) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function hashText(s) {
  return Buffer.from(s || "", "utf8").toString("base64").slice(0, 64);
}

// ===================== LOG =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  try { fs.appendFileSync("bot.log", line); } catch {}
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const line =
`========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================\n`;
  try { fs.appendFileSync("leads_quentes.txt", line); } catch {}
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

// ===================== AVISO HUMANO =====================
async function avisarHumano(texto) {
  await enviarMensagem(HUMAN_WHATSAPP_NUMBER, `🔥 LEAD QUENTE 🔥\n\n${texto}`);
}

// ===================== WHATSAPP MEDIA (download) =====================
async function getMediaMeta(mediaId) {
  const r = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 15000,
  });
  return r.data; // {url, mime_type, sha256, file_size, id}
}

async function downloadMediaBytes(url) {
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
  });
  return Buffer.from(r.data);
}

// ===================== OPENAI: áudio -> texto =====================
async function transcribeAudio(buffer, mimeType = "audio/ogg") {
  // Node 18+ tem Blob; File nem sempre. OpenAI SDK aceita Blob.
  const blob = new Blob([buffer], { type: mimeType });

  // Whisper é bem estável
  const tr = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: blob,
  });

  // SDK pode retornar {text: "..."}
  return (tr?.text || "").trim();
}

// ===================== OPENAI: imagem -> resposta =====================
async function replyWithVision({ system, userText, imageBuffer, mimeType }) {
  const b64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const r = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  return (r.output_text || "").trim();
}

// ===================== OBJEÇÕES (respostas rápidas) =====================
const OBJECTIONS = [
  {
    key: "funciona",
    match: (t) => t.includes("funciona"),
    answer: "Funciona sim, quando a pessoa aplica do jeito certo 🙂\nVocê quer usar isso mais pra aprender do zero ou pra gerar renda?",
  },
  {
    key: "tempo",
    match: (t) => t.includes("quanto tempo") || (t.includes("resultado") && t.includes("tempo")),
    answer: "Depende do seu ritmo e execução 🙂\nVocê pensa em curto ou médio prazo?",
  },
  {
    key: "ja_tentei",
    match: (t) => t.includes("ja tentei") || t.includes("já tentei") || t.includes("nao deu certo") || t.includes("não deu certo"),
    answer: "Entendo, isso acontece quando falta direção.\nO que mais te travou naquela vez?",
  },
  {
    key: "medo_dinheiro",
    match: (t) => t.includes("medo") && t.includes("dinheiro"),
    answer: "Faz sentido ter esse receio.\nSeu medo é mais de investir errado ou de continuar como tá hoje?",
  },
  {
    key: "suporte",
    match: (t) => t.includes("suporte"),
    answer: "Tem suporte sim 😊\nPra você, acompanhamento faz diferença?",
  },
  {
    key: "parcelar",
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    answer: "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== PROMPT (produção) =====================
function systemPrompt(stage, expensiveCount) {
  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS:
- Nunca diga que é IA, robô, sistema ou automação.
- Estilo WhatsApp BR: curto, direto e humano.
- 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Sempre conduza para o próximo passo.

ESTÁGIO DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: mostrar valor + clareza (sem preço)
- STAGE_3: decisão (objetivo: avançar)
- STAGE_4: objeção de preço (validar, perguntar, construir valor)

PRODUTO (use em frases curtas, sem textos longos):
${PRODUCT_NAME} é um método prático pra iniciantes ganharem dinheiro online com passo a passo, ações simples, direção clara e suporte.
Garantia: 7 dias. Acesso imediato após pagamento.

GUARDIÃO DE PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e pergunte se faz sentido.
- Nunca liste vários preços.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que: expensiveCount >= 2 e após perguntas.
- Links só se o cliente pedir claramente.

Links:
- Oferta: ${LINK_OFFER}
- Integral: ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL}

IMPORTANTE:
Se o cliente enviar mídia, responda com base no conteúdo e faça 1 pergunta estratégica.
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
  // responde rápido 200 para evitar retries
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const messageId = msg.id || null;

    const session = getSession(from);

    // DEDUPE: evita responder duas vezes ao mesmo evento
    if (messageId && session.lastInboundId === messageId) {
      log("DEDUPE", "Ignorado msg duplicada", `from=${from} id=${messageId}`);
      return;
    }
    session.lastInboundId = messageId;

    // Detecta tipo
    const type = msg.type; // "text", "audio", "image", "document", "video", ...
    let rawText = "";
    let t = "";

    // ---------- TEXT ----------
    if (type === "text" && msg.text?.body) {
      rawText = msg.text.body.trim();
      t = normalize(rawText);
    }

    // ---------- AUDIO ----------
    if (type === "audio" && msg.audio?.id) {
      log("IN", `${from}`, `audio id=${msg.audio.id}`);
      const meta = await getMediaMeta(msg.audio.id);
      const bytes = await downloadMediaBytes(meta.url);
      const transcript = await transcribeAudio(bytes, meta.mime_type || "audio/ogg");
      rawText = transcript ? `ÁUDIO (transcrito): ${transcript}` : "ÁUDIO: (não consegui transcrever)";
      t = normalize(transcript || "");
      log("AUDIO_TXT", `${from}`, `"${transcript || "SEM_TEXTO"}"`);
    }

    // ---------- IMAGE ----------
    let imageBytes = null;
    let imageMime = null;
    if (type === "image" && msg.image?.id) {
      log("IN", `${from}`, `image id=${msg.image.id}`);
      const meta = await getMediaMeta(msg.image.id);
      imageBytes = await downloadMediaBytes(meta.url);
      imageMime = meta.mime_type || "image/jpeg";
      rawText = "IMAGEM recebida";
      t = ""; // texto não vem, então regras textuais não disparam
    }

    // ---------- DOCUMENT/VIDEO/OTHER ----------
    if (!rawText && (type === "document" || type === "video" || type === "sticker")) {
      // não travar: responder pedindo contexto
      const reply = "Recebi seu arquivo 🙂\nEm 1 frase: o que você quer que eu veja nele?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: `[${type}]` });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    if (!rawText && type !== "image") {
      // nada processável
      return;
    }

    // Guard: mensagem repetida (texto)
    if (rawText) {
      const inboundHash = hashText(rawText);
      if (session.lastInboundHash === inboundHash) {
        log("DEDUPE", "Ignorado msg repetida por hash", `from=${from}`);
        return;
      }
      session.lastInboundHash = inboundHash;
    }

    log("IN", `${from}`, `type=${type} stage=${session.stage} text="${rawText}"`);

    // ===================== UPDATE STAGE (só se tiver texto analisável) =====================
    if (type === "text" || type === "audio") {
      if (session.stage === 0 && session.history.length > 0) session.stage = 1;
      if (isInterested(t)) session.stage = Math.max(session.stage, 2);
      if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;

      if (isExpensive(t)) {
        session.expensiveCount += 1;
        session.stage = 4;
      }
    }

    // ===================== AVISO HUMANO (1x) =====================
    // Aviso humano acontece, mas SEM mandar mensagem “consultor” pro cliente automaticamente.
    // E NÃO bloqueia o envio do link quando o cliente pede.
    if (HANDOFF_MODE === "B" && session.stage >= 3 && !session.humanNotified) {
      await avisarHumano(`Número: ${from}\nStage: ${session.stage}\nMsg: "${rawText}"`);
      registrarLeadQuente({
        phone: from,
        motivo: `Lead quente (STAGE_${session.stage})`,
        mensagem: rawText,
      });
      session.humanNotified = true;
      session.handoffUntil = Date.now() + HANDOFF_PAUSE_MS;
    }

    // ===================== PRIORIDADE: LINK (se pediu) =====================
    // Se o cliente pedir link/comprar, NUNCA mande a frase do consultor.
    if (type === "text" || type === "audio") {
      if (isCheckoutIntent(t)) {
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
    }

    // ===================== Handoff pausa (5 min) =====================
    // Durante a pausa, o bot só faz “checkpoint” curto — MAS ainda responde preço se perguntarem.
    if (HANDOFF_MODE === "B" && session.handoffUntil && Date.now() < session.handoffUntil) {
      // deixa passar preço normalmente abaixo; aqui só bloqueia IA longa
      if (type === "text" || type === "audio") {
        if (!isPriceQuestion(t)) {
          const reply = "Entendi 🙂\nMe diz só: seu objetivo é renda extra ou algo mais consistente?";
          await humanDelay(reply);
          await enviarMensagem(from, reply);

          session.history.push({ role: "user", content: rawText });
          session.history.push({ role: "assistant", content: reply });
          return;
        }
      }
    }

    // ===================== OBJEÇÕES (texto/áudio) =====================
    if (type === "text" || type === "audio") {
      for (const item of OBJECTIONS) {
        if (item.match(t)) {
          const reply = item.answer;
          await humanDelay(reply);
          await enviarMensagem(from, reply);

          session.history.push({ role: "user", content: rawText });
          session.history.push({ role: "assistant", content: reply });
          return;
        }
      }
    }

    // ===================== PREÇO (guardião) =====================
    if (type === "text" || type === "audio") {
      if (isPriceQuestion(t)) {
        session.priceExplained = true;
        const reply =
          `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nFaz sentido pro seu objetivo agora?`;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: rawText });
        session.history.push({ role: "assistant", content: reply });
        return;
      }
    }

    // ===================== IA =====================
    const sys = systemPrompt(session.stage, session.expensiveCount);

    let reply = "";

    // IMAGEM: usar visão
    if (type === "image" && imageBytes) {
      const userText = "O cliente enviou uma imagem. Entenda o conteúdo e responda como Sarah, mantendo regras (curto + 1 pergunta estratégica).";
      reply = await replyWithVision({
        system: sys,
        userText,
        imageBuffer: imageBytes,
        mimeType: imageMime || "image/jpeg",
      });
    } else {
      // TEXTO / ÁUDIO transcrito
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          ...session.history.slice(-8),
          { role: "user", content: rawText },
        ],
      });
      reply = completion.choices?.[0]?.message?.content?.trim() || "Entendi 🙂\nQual é seu objetivo principal hoje?";
    }

    reply = truncate(reply, 700);

    // GUARD: não mandar link se cliente não pediu
    if (!(type === "text" || type === "audio") || !isCheckoutIntent(t)) {
      reply = stripUrls(reply);
    }

    // GUARD: não falar preço do nada (só se perguntou preço)
    if (!session.priceExplained && !(type === "text" || type === "audio" ? isPriceQuestion(t) : false)) {
      reply = reply.replace(/R\$\s?\d+([.,]\d+)?/g, "").trim();
    }

    // GUARD: 125 só após 2 objeções
    if (session.expensiveCount < 2) {
      reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
    }

    // salva histórico
    session.history.push({ role: "user", content: rawText || `[${type}]` });
    session.history.push({ role: "assistant", content: reply });

    log("OUT", `${from}`, `stage=${session.stage} reply="${reply}"`);

    await humanDelay(reply);
    await enviarMensagem(from, reply);
  } catch (e) {
    log("ERROR", "Webhook falhou", e?.response?.data ? JSON.stringify(e.response.data) : e?.message);
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
