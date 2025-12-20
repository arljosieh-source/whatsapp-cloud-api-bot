import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import { toFile } from "openai/uploads";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "2mb" })); // webhook pequeno

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Número do humano para receber aviso (SÓ NÚMEROS com DDI, sem "+" e sem espaços)
// Ex Brasil: 5511999999999
const HUMAN_WHATSAPP_NUMBER = process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195;   // 35% OFF (oferta padrão sempre)
const PRICE_SPECIAL = 125; // só após >= 2 objeções reais de preço

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== MODO DO PROJETO (Opção B) =====================
// B) Vender sozinho, mas avisar humano quando lead estiver quente, e pausar 5 min
const HANDOFF_MODE = "B";
const HANDOFF_PAUSE_MS = 5 * 60 * 1000;

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== CHECK ENV =====================
if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.warn(
    "⚠️ Variáveis faltando. Confira: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY"
  );
}

// ===================== MEMÓRIA EM RAM =====================
// Reinicia quando Render reinicia (você escolheu assim)
const sessions = new Map();
/**
 * session = {
 *   history: [{role, content}],
 *   stage: 0..4,
 *   priceExplained: boolean,
 *   expensiveCount: number,
 *   linkSentAt: number|null,
 *   humanNotified: boolean,
 *   handoffUntil: number,
 *   lastInboundId: string|null
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
      handoffUntil: 0,
      lastInboundId: null,
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  const min = 1500; // nunca responder instantâneo
  let ms = 3000;    // curto
  if (len > 240) ms = 15000; // longo
  else if (len > 80) ms = 8000; // médio
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
  return containsAny(t, [
    "funciona",
    "como funciona",
    "suporte",
    "garantia",
    "serve pra mim",
    "da certo",
    "dá certo",
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

function isTooShort(raw) {
  return (raw || "").trim().length < 2;
}

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

// ===================== WHATSAPP SEND (texto) =====================
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

// (Opcional) Enviar imagem por link público (se você tiver um link de imagem hospedada)
// async function enviarImagem(to, imageLink, caption = "") {
//   await axios.post(
//     `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
//     {
//       messaging_product: "whatsapp",
//       to,
//       type: "image",
//       image: { link: imageLink, caption },
//     },
//     {
//       headers: {
//         Authorization: `Bearer ${WHATSAPP_TOKEN}`,
//         "Content-Type": "application/json",
//       },
//       timeout: 15000,
//     }
//   );
// }

// ===================== AVISO HUMANO =====================
async function avisarHumano(texto) {
  // manda para o número humano usando o MESMO número do bot (Cloud API)
  await enviarMensagem(HUMAN_WHATSAPP_NUMBER, `🔥 LEAD QUENTE 🔥\n\n${texto}`);
}

// ===================== RESPOSTAS PADRÃO (sem IA) =====================
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
      "Entendo, isso acontece bastante quando falta direção.\nO que mais te travou naquela vez?",
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
    key: "tempo_por_dia",
    match: (t) => t.includes("tempo por dia") || t.includes("muito tempo"),
    answer:
      "Dá pra começar com pouco tempo e ir ajustando.\nHoje você teria quanto tempo por dia, mais ou menos?",
  },
  {
    key: "suporte",
    match: (t) => t.includes("suporte"),
    answer:
      "Tem suporte sim 😊\nPra você, ter acompanhamento faz diferença?",
  },
  {
    key: "anuncio",
    match: (t) => t.includes("anuncio") || t.includes("anúncio") || t.includes("trafego") || t.includes("tráfego"),
    answer:
      "No começo não precisa.\nVocê prefere começar sem gastos extras?",
  },
  {
    key: "piramide",
    match: (t) => t.includes("piramide") || t.includes("pirâmide"),
    answer:
      "Não é pirâmide.\nVocê já teve alguma experiência ruim com algo parecido antes?",
  },
  {
    key: "cnpj",
    match: (t) => t.includes("cnpj"),
    answer:
      "Não precisa de CNPJ pra começar.\nVocê quer começar simples ou já pensa em algo mais estruturado?",
  },
  {
    key: "parcelar",
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    answer:
      "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== PROMPT (produção) =====================
function systemPrompt(stage, expensiveCount) {
  // Integra mais infos do produto, mas mantendo “WhatsApp curto”
  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS OBRIGATÓRIAS:
- Nunca diga que é IA, robô, sistema ou automação.
- Estilo WhatsApp BR: curto, direto, humano.
- 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Sempre conduza para o próximo passo.

PRODUTO (use pedaços curtos):
Mapa Diamond é um método comprovado de renda extra para iniciantes no digital.
Ele mostra passo a passo ações simples que destravam novas fontes de lucro, aumentam autoridade digital e criam evolução financeira.
Pontos fortes: direção clara, método validado, menos tentativa e erro, suporte, acesso imediato e garantia de 7 dias.

ESTÁGIO DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: mostrar valor + clareza (sem preço)
- STAGE_3: decisão (objetivo: avançar)
- STAGE_4: objeção de preço (validar, perguntar, construir valor e fechar)

GUARDIÃO DO PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e pergunte se faz sentido.
- Não liste vários valores.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que: o cliente tenha dito que está caro pelo menos 2 vezes (expensiveCount >= 2) e você já fez perguntas.
- Links só se o cliente pedir claramente (manda link / quero comprar / como pagar).

Links permitidos somente quando o cliente pedir:
- Oferta (R$ ${PRICE_OFFER}): ${LINK_OFFER}
- Integral: ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL}

IMPORTANTE:
Quando chegar imagem/áudio, você deve interpretar e responder de forma objetiva e útil.
`;
}

// ===================== WHATSAPP MEDIA (download) =====================
// Pega URL do arquivo na Meta usando media_id
async function getMediaUrl(mediaId) {
  const resp = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 15000,
  });
  return resp.data; // { url, mime_type, sha256, file_size, id }
}

// Baixa o arquivo do WhatsApp (precisa do token)
async function downloadMediaBinary(url) {
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(resp.data);
}

// Transcreve áudio com OpenAI
async function transcribeAudio({ buffer, mimeType }) {
  const safeMime = mimeType || "audio/ogg";
  const filename =
    safeMime.includes("mpeg") ? "audio.mp3" :
    safeMime.includes("wav") ? "audio.wav" :
    safeMime.includes("mp4") ? "audio.m4a" :
    "audio.ogg";

  const file = await toFile(buffer, filename, { type: safeMime });

  const transcription = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
  });

  // SDK retorna texto em transcription.text
  return transcription.text || "";
}

// Entende imagem com OpenAI (vision)
async function analyzeImage({ buffer, mimeType, stage, expensiveCount }) {
  const mt = mimeType || "image/jpeg";
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mt};base64,${b64}`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: systemPrompt(stage, expensiveCount),
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Analise a imagem enviada pelo cliente e responda de forma útil e conversacional, mantendo as regras do WhatsApp." },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  return (resp.output_text || "").trim();
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
  // Sempre responde 200 rápido para a Meta (evita reenvio)
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const messageId = msg.id || null;
    const session = getSession(from);

    // Dedupe básico
    if (messageId && session.lastInboundId === messageId) {
      log("DEDUPE", `Ignorado duplicada`, `from=${from} id=${messageId}`);
      return;
    }
    session.lastInboundId = messageId;

    // ===================== HANDOFF (pausa) =====================
    // Se já foi "handoff" e ainda está na pausa, não deixa o bot competir
    if (HANDOFF_MODE === "B" && Date.now() < session.handoffUntil) {
      const reply = "Já acionei o consultor 🙂\nVocê prefere adiantar o preço com a oferta de hoje ou esperar ele te orientar?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: "[mensagem durante handoff]" });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== DETECTAR TIPO DE MENSAGEM =====================
    // WhatsApp pode mandar: text, image, audio, video, document...
    const type = msg.type;

    // ------------------ TEXTO ------------------
    if (type === "text") {
      const raw = msg.text?.body || "";
      if (isTooShort(raw)) return;

      const t = normalize(raw);

      log("IN_TEXT", `${from}`, `"${raw}" stage=${session.stage}`);

      // ====== UPDATE STAGE ======
      if (session.stage === 0 && session.history.length > 0) session.stage = 1;
      if (isInterested(t)) session.stage = Math.max(session.stage, 2);
      if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;

      if (isExpensive(t)) {
        session.expensiveCount += 1;
        session.stage = 4;
      }

      // ====== LEAD QUENTE => avisar humano 1 vez + pausa 5 min ======
      if (HANDOFF_MODE === "B" && session.stage >= 3 && !session.humanNotified) {
        await avisarHumano(`Número: ${from}\nStage: ${session.stage}\nMsg: "${raw}"`);
        registrarLeadQuente({
          phone: from,
          motivo: `Lead quente (STAGE_${session.stage})`,
          mensagem: raw,
        });
        session.humanNotified = true;
        session.handoffUntil = Date.now() + HANDOFF_PAUSE_MS;

        const reply =
          "Perfeito — já chamei um consultor pra te atender rapidinho 🙂\nEnquanto isso, seu objetivo é renda extra ou algo mais consistente?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      // ====== RESPOSTAS PADRÃO (sem IA) ======
      for (const item of OBJECTIONS) {
        if (item.match(t)) {
          const reply = item.answer;
          await humanDelay(reply);
          await enviarMensagem(from, reply);

          session.history.push({ role: "user", content: raw });
          session.history.push({ role: "assistant", content: reply });
          return;
        }
      }

      // ====== PREÇO (guardião) ======
      if (isPriceQuestion(t)) {
        session.priceExplained = true;

        const reply =
          `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nIsso faz sentido pra você agora?`;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      // ====== COMPRA (link só se pedir) ======
      if (isCheckoutIntent(t)) {
        if (!canSendLink(session)) {
          const reply = "Perfeito.\nVocê prefere pagar à vista ou parcelado?";
          await humanDelay(reply);
          await enviarMensagem(from, reply);

          session.history.push({ role: "user", content: raw });
          session.history.push({ role: "assistant", content: reply });
          return;
        }

        session.linkSentAt = Date.now();

        const reply =
          `Fechado 🙂\nAqui está o link com a oferta de hoje (R$ ${PRICE_OFFER}):\n${LINK_OFFER}\nPrefere pagar à vista ou parcelado?`;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      // ====== IA (texto) ======
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          ...session.history.slice(-8),
          { role: "user", content: raw },
        ],
      });

      let reply =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Entendi.\nMe conta seu objetivo pra eu te orientar certinho?";
      reply = truncate(reply, 700);

      // GUARD: não mandar link se não pediu
      if (!isCheckoutIntent(t)) {
        reply = stripUrls(reply);
      }

      // GUARD: preço só aparece se perguntou preço
      if (!session.priceExplained && !isPriceQuestion(t)) {
        reply = reply.replace(/R\$\s?\d+(\.\d+)?/g, "").trim();
      }

      // GUARD: nunca “125” antes do tempo
      if (session.expensiveCount < 2) {
        reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
      }

      log("OUT_TEXT", `${from}`, `"${reply}" stage=${session.stage}`);

      session.history.push({ role: "user", content: raw });
      session.history.push({ role: "assistant", content: reply });

      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // ------------------ IMAGEM ------------------
    if (type === "image") {
      const mediaId = msg.image?.id;
      if (!mediaId) return;

      log("IN_IMAGE", `${from}`, `mediaId=${mediaId}`);

      // Atualiza estágio: imagem geralmente indica engajamento
      if (session.stage === 0) session.stage = 1;

      const meta = await getMediaUrl(mediaId);
      const buffer = await downloadMediaBinary(meta.url);

      const aiText = await analyzeImage({
        buffer,
        mimeType: meta.mime_type,
        stage: session.stage,
        expensiveCount: session.expensiveCount,
      });

      let reply = aiText || "Consegui ver sua imagem 🙂\nVocê quer que eu analise o que exatamente nela?";
      reply = truncate(reply, 700);
      reply = stripUrls(reply);

      session.history.push({ role: "user", content: "[imagem enviada]" });
      session.history.push({ role: "assistant", content: reply });

      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // ------------------ ÁUDIO ------------------
    if (type === "audio") {
      const mediaId = msg.audio?.id;
      if (!mediaId) return;

      log("IN_AUDIO", `${from}`, `mediaId=${mediaId}`);

      if (session.stage === 0) session.stage = 1;

      const meta = await getMediaUrl(mediaId);
      const buffer = await downloadMediaBinary(meta.url);

      const transcript = await transcribeAudio({
        buffer,
        mimeType: meta.mime_type,
      });

      const userText = (transcript || "").trim();
      const safeTranscript = userText || "(áudio curto/inaudível)";

      // trata como texto normal depois de transcrever
      const t = normalize(safeTranscript);

      // Update stage com base no texto transcrito
      if (session.stage === 0 && session.history.length > 0) session.stage = 1;
      if (isInterested(t)) session.stage = Math.max(session.stage, 2);
      if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;
      if (isExpensive(t)) {
        session.expensiveCount += 1;
        session.stage = 4;
      }

      // Lead quente => avisar humano 1 vez
      if (HANDOFF_MODE === "B" && session.stage >= 3 && !session.humanNotified) {
        await avisarHumano(`Número: ${from}\nStage: ${session.stage}\nÁudio transcrito: "${safeTranscript}"`);
        registrarLeadQuente({
          phone: from,
          motivo: `Lead quente via áudio (STAGE_${session.stage})`,
          mensagem: safeTranscript,
        });
        session.humanNotified = true;
        session.handoffUntil = Date.now() + HANDOFF_PAUSE_MS;

        const reply = "Perfeito — já chamei um consultor 🙂\nSeu objetivo é renda extra ou algo mais consistente?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: `[áudio] ${safeTranscript}` });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      // IA com texto transcrito
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          ...session.history.slice(-8),
          { role: "user", content: `O cliente enviou um áudio. Transcrição: "${safeTranscript}"` },
        ],
      });

      let reply =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Entendi seu áudio 🙂\nMe diz só: seu objetivo é renda extra ou algo mais consistente?";
      reply = truncate(reply, 700);
      reply = stripUrls(reply);

      session.history.push({ role: "user", content: `[áudio] ${safeTranscript}` });
      session.history.push({ role: "assistant", content: reply });

      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return;
    }

    // ------------------ VÍDEO (limitação prática) ------------------
    if (type === "video") {
      log("IN_VIDEO", `${from}`, "vídeo recebido");
      const reply =
        "Consegui receber seu vídeo 🙂\nPra eu te ajudar bem rápido: o que você quer que eu avalie nele, ou consegue me mandar um print do ponto principal?";
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: "[vídeo enviado]" });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ------------------ OUTROS TIPOS ------------------
    const reply =
      "Recebi sua mensagem 🙂\nVocê consegue me mandar em texto o que você precisa pra eu te orientar certinho?";
    await humanDelay(reply);
    await enviarMensagem(from, reply);

    session.history.push({ role: "user", content: `[${type}]` });
    session.history.push({ role: "assistant", content: reply });
  } catch (e) {
    log("ERROR", "Webhook falhou", e?.response?.data ? JSON.stringify(e.response.data) : e?.message);
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
